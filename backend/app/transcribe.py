import asyncio
import logging
from collections.abc import Awaitable, Callable

import boto3
from smithy_http.aio.crt import AWSCRTHTTPClient
from aws_sdk_transcribe_streaming.client import AsyncTranscribeStreamingClient
from aws_sdk_transcribe_streaming.config import AsyncTranscribeStreamingConfig
from aws_sdk_transcribe_streaming.models import (
    AudioEvent,
    AudioStreamAudioEvent,
    LanguageCode,
    MediaEncoding,
    PartialResultsStability,
    StartStreamTranscriptionInput,
    TranscriptResultStreamBadRequestException,
    TranscriptResultStreamConflictException,
    TranscriptResultStreamInternalFailureException,
    TranscriptResultStreamLimitExceededException,
    TranscriptResultStreamServiceUnavailableException,
    TranscriptResultStreamTranscriptEvent,
    TranscriptResultStreamUnknown,
)

from .config import settings

AudioCallback = Callable[[str, bool], Awaitable[None]]
logger = logging.getLogger(__name__)


async def transcribe_audio(chunks: asyncio.Queue[bytes | None], on_transcript: AudioCallback) -> None:
    """Forward PCM16 mono audio to Transcribe and relay partial/final text to the caller."""
    logger.info("transcribe_audio started")

    credentials = boto3.Session(region_name=settings.aws_region).get_credentials()
    if credentials is None:
        raise RuntimeError(
            "No AWS credentials found. Run 'aws sso login' or configure credentials."
        )
    frozen = credentials.get_frozen_credentials()
    logger.info("AWS credentials resolved through boto3")

    config = await AsyncTranscribeStreamingConfig.resolve(
        region=settings.aws_region,
        transport=AWSCRTHTTPClient(),
        aws_access_key_id=frozen.access_key,
        aws_secret_access_key=frozen.secret_key,
        aws_session_token=frozen.token,
    )

    client = AsyncTranscribeStreamingClient(config=config)

    logger.info("Calling start_stream_transcription (region=%s)", settings.aws_region)
    try:
        stream = await client.start_stream_transcription(
            input=StartStreamTranscriptionInput(
                language_code=LanguageCode.EN_US,
                media_sample_rate_hertz=16_000,
                media_encoding=MediaEncoding.PCM,
                enable_partial_results_stabilization=True,
                partial_results_stability=PartialResultsStability.MEDIUM,
            )
        )
    except Exception as exc:
        logger.exception("start_stream_transcription failed: %s", exc)
        raise

    logger.info("Transcribe stream opened; awaiting initial response")

    async with stream:
        async def send_audio() -> None:
            sent_chunks = 0
            sent_bytes = 0
            try:
                while True:
                    chunk = await chunks.get()
                    if chunk is None:
                        logger.info("Audio queue drained; closing Transcribe input")
                        break
                    if chunk:
                        if sent_chunks == 0:
                            logger.info("Sending first audio chunk to Amazon Transcribe (%d bytes)", len(chunk))
                        await stream.input_stream.send(
                            AudioStreamAudioEvent(value=AudioEvent(audio_chunk=chunk))
                        )
                        sent_chunks += 1
                        sent_bytes += len(chunk)
                        if sent_chunks % 50 == 0:
                            logger.info("Forwarded %d audio chunks to Amazon Transcribe", sent_chunks)
            finally:
                # Closing input tells Transcribe that no more audio events will follow.
                await stream.input_stream.close()
                logger.info(
                    "Closed Transcribe input after sending %d chunks, %d bytes",
                    sent_chunks,
                    sent_bytes,
                )

        async def receive_transcripts() -> None:
            # await_output() blocks until the service sends its initial response,
            # which only happens after it has received some audio — so send_audio()
            # must be running concurrently before we call this.
            try:
                _, output_stream = await stream.await_output()
            except Exception as exc:
                logger.exception("await_output failed: %s", exc)
                raise
            logger.info("await_output succeeded")
            if output_stream is None:
                raise RuntimeError("Amazon Transcribe did not return an output stream")

            event_count = 0
            result_count = 0
            text_count = 0
            async for event in output_stream:
                event_count += 1
                if event_count == 1:
                    logger.info("Received first Amazon Transcribe response event: %s", type(event).__name__)
                if isinstance(event, TranscriptResultStreamUnknown):
                    logger.warning("Amazon Transcribe returned an unknown event: %s", event.tag)
                    continue
                if isinstance(
                    event,
                    (
                        TranscriptResultStreamBadRequestException,
                        TranscriptResultStreamConflictException,
                        TranscriptResultStreamInternalFailureException,
                        TranscriptResultStreamLimitExceededException,
                        TranscriptResultStreamServiceUnavailableException,
                    ),
                ):
                    detail = getattr(event.value, "message", None) or type(event).__name__
                    raise RuntimeError(f"Amazon Transcribe stream error: {detail}")
                if not isinstance(event, TranscriptResultStreamTranscriptEvent):
                    logger.warning("Amazon Transcribe returned an unexpected event: %s", type(event).__name__)
                    continue
                transcript = event.value.transcript
                if not transcript:
                    continue
                for result in transcript.results or []:
                    result_count += 1
                    alternatives = result.alternatives or []
                    if alternatives and alternatives[0].transcript:
                        text_count += 1
                        await on_transcript(alternatives[0].transcript, not result.is_partial)
            logger.info(
                "Amazon Transcribe response stream ended: %d events, %d results, %d with text",
                event_count,
                result_count,
                text_count,
            )

        # send_audio and receive_transcripts run concurrently — this is required.
        # receive_transcripts calls await_output() which only resolves after the
        # service receives audio, so send_audio must already be running.
        await asyncio.gather(send_audio(), receive_transcripts())
