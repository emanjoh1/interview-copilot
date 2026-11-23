import asyncio
import io
import json
import logging
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pypdf import PdfReader
from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph

from .config import settings
from .interview import generate_answer, solve_coding_problem
from .transcribe import transcribe_audio

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_PDF_PAGES = 100
CONTEXT_CHAR_LIMITS = {"resume": 20_000, "job_description": 10_000}
SUPPORTED_CONTEXT_EXTENSIONS = {".pdf", ".docx", ".txt"}
MAX_SCREENSHOT_BYTES = 3_750_000  # Bedrock Converse per-image limit
CODING_LANGUAGES = {"Python", "JavaScript", "TypeScript", "Java", "C++", "C#", "Go", "Kotlin", "Swift", "Ruby", "Rust", "SQL"}


class HistoryTurn(BaseModel):
    question: str
    answer: str


class AnswerRequest(BaseModel):
    transcript: str = Field(min_length=5, max_length=12000)
    history: list[HistoryTurn] = Field(default_factory=list, max_length=20)
    resume: str | None = Field(default=None, max_length=20000)
    job_description: str | None = Field(default=None, max_length=20000)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="InterviewCopilot API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin, settings.desktop_origin],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "interview-copilot-api", "region": settings.aws_region}


@app.post("/api/answer")
async def answer(request: AnswerRequest):
    try:
        result = await asyncio.to_thread(
            generate_answer,
            request.transcript,
            [t.model_dump() for t in request.history],
            request.resume,
            request.job_description,
        )
        return {"answer": result}
    except RuntimeError as exc:
        logger.exception("Answer generation failed")
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/api/solve")
async def solve(
    image: UploadFile = File(...),
    language: str = Form("Python"),
    notes: str | None = Form(default=None, max_length=2000),
):
    """Read a coding problem from a screenshot and return a worked solution."""
    if language not in CODING_LANGUAGES:
        raise HTTPException(status_code=400, detail=f"Unsupported language. Choose one of: {', '.join(sorted(CODING_LANGUAGES))}.")
    contents = await image.read(MAX_SCREENSHOT_BYTES + 1)
    await image.close()
    if len(contents) > MAX_SCREENSHOT_BYTES:
        raise HTTPException(status_code=413, detail="Screenshot must be 3.75 MB or smaller.")
    if contents.startswith(b"\x89PNG\r\n\x1a\n"):
        image_format = "png"
    elif contents.startswith(b"\xff\xd8\xff"):
        image_format = "jpeg"
    else:
        raise HTTPException(status_code=415, detail="Screenshot must be a PNG or JPEG image.")
    try:
        result = await asyncio.to_thread(solve_coding_problem, contents, image_format, language, notes)
        return {"solution": result}
    except RuntimeError as exc:
        logger.exception("Coding solution failed")
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/api/context/file")
async def extract_context_file(
    file: UploadFile = File(...),
    context_type: Literal["resume", "job_description"] = Form(...),
):
    """Extract text from a PDF, DOCX, or TXT file for interview context."""
    filename = file.filename or "uploaded-file"
    extension = Path(filename).suffix.lower()
    if extension not in SUPPORTED_CONTEXT_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Choose a PDF, DOCX, or TXT file.")

    contents = await file.read(MAX_UPLOAD_BYTES + 1)
    await file.close()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Files must be 10 MB or smaller.")

    pages = None
    truncated = False
    char_limit = CONTEXT_CHAR_LIMITS[context_type]
    try:
        if extension == ".pdf":
            if b"%PDF-" not in contents[:1024]:
                raise HTTPException(status_code=415, detail="The uploaded file does not appear to be a PDF.")
            reader = PdfReader(io.BytesIO(contents), strict=False)
            if reader.is_encrypted:
                raise HTTPException(status_code=400, detail="Password-protected PDFs are not supported.")
            pages = len(reader.pages)
            if pages > MAX_PDF_PAGES:
                raise HTTPException(status_code=413, detail="PDF must have 100 pages or fewer.")
            blocks: list[str] = []
            for page in reader.pages:
                page_text = (page.extract_text() or "").strip()
                if page_text:
                    blocks.append(page_text)
            extracted_text = "\n\n".join(blocks)
        elif extension == ".docx":
            with zipfile.ZipFile(io.BytesIO(contents)) as archive:
                entries = archive.infolist()
                if len(entries) > 1000 or sum(entry.file_size for entry in entries) > 50 * 1024 * 1024:
                    raise HTTPException(status_code=413, detail="DOCX file contents are too large to process.")
                if "word/document.xml" not in archive.namelist():
                    raise HTTPException(status_code=415, detail="The uploaded file does not appear to be a DOCX document.")
            document = Document(io.BytesIO(contents))
            blocks = []
            for block in document.iter_inner_content():
                if isinstance(block, Paragraph):
                    if block.text.strip():
                        blocks.append(block.text.strip())
                elif isinstance(block, Table):
                    for row in block.rows:
                        cells = [cell.text.strip() for cell in row.cells if cell.text.strip()]
                        if cells:
                            blocks.append(" | ".join(cells))
            extracted_text = "\n\n".join(blocks)
        else:
            try:
                extracted_text = contents.decode("utf-8-sig")
            except UnicodeDecodeError as exc:
                raise HTTPException(status_code=400, detail="TXT files must use UTF-8 text encoding.") from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.info("Could not extract text from uploaded file (%s)", type(exc).__name__)
        raise HTTPException(
            status_code=400,
            detail="Could not read this file. Check that it is a valid PDF, DOCX, or UTF-8 TXT file.",
        ) from exc

    extracted_text = extracted_text.strip()
    if not extracted_text:
        detail = "No selectable text was found. Scanned PDFs need OCR before upload." if extension == ".pdf" else "No text was found in this file."
        raise HTTPException(status_code=422, detail=detail)

    if len(extracted_text) > char_limit:
        extracted_text = extracted_text[:char_limit]
        truncated = True

    return {
        "text": extracted_text,
        "filename": filename,
        "pages": pages,
        "truncated": truncated,
        "context_type": context_type,
        "format": extension[1:],
    }


@app.websocket("/ws/transcribe")
async def websocket_transcribe(websocket: WebSocket):
    await websocket.accept()
    audio_queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=40)

    async def send_transcript(text: str, is_final: bool) -> None:
        await websocket.send_text(json.dumps({"type": "transcript", "text": text, "is_final": is_final}))

    async def receive_audio() -> None:
        received_chunks = 0
        received_bytes = 0
        try:
            while True:
                message = await websocket.receive()
                if message.get("bytes") is not None:
                    received_chunks += 1
                    received_bytes += len(message["bytes"])
                    try:
                        audio_queue.put_nowait(message["bytes"])
                    except asyncio.QueueFull:
                        # Drop the oldest queued frame to keep latency bounded.
                        _ = audio_queue.get_nowait()
                        audio_queue.put_nowait(message["bytes"])
                elif message.get("text"):
                    payload = json.loads(message["text"])
                    if payload.get("type") == "stop":
                        logger.info(
                            "Audio capture stopped: %d chunks, %d bytes",
                            received_chunks,
                            received_bytes,
                        )
                        break
        except WebSocketDisconnect:
            logger.info(
                "Audio WebSocket disconnected: %d chunks, %d bytes",
                received_chunks,
                received_bytes,
            )
        finally:
            await audio_queue.put(None)

    try:
        logger.info("Starting Amazon Transcribe streaming session")
        transcription_task = asyncio.create_task(transcribe_audio(audio_queue, send_transcript))
        receive_task = asyncio.create_task(receive_audio())
        # Wait for receive_audio to finish first (client sent stop or disconnected),
        # then wait for the transcription task to drain and finish naturally.
        await receive_task
        if receive_task.exception():
            transcription_task.cancel()
            raise receive_task.exception()
        # receive_audio put None in the queue — transcription will drain and finish.
        try:
            await transcription_task
        except Exception as exc:
            raise exc
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.exception("Transcription websocket failed")
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": str(exc)}))
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
