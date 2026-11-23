import re
import boto3
from botocore.exceptions import BotoCoreError, ClientError

from .config import settings

TECH_CORRECTIONS: list[tuple[str, str]] = [
    # Terraform variants — catch all phonetic mishearings
    (r'\btega\s*form\b',          'Terraform'),
    (r'\btega\s*phone\b',         'Terraform'),
    (r'\btega\s*phon\b',          'Terraform'),
    (r'\btera\s*form\b',          'Terraform'),
    (r'\bterror\s*form\b',        'Terraform'),
    (r'\btear\s*form\b',          'Terraform'),
    (r'\bterr\s*form\b',          'Terraform'),
    # Kubernetes variants
    (r'\bcurb\s*er\s*net\s*ease\b', 'Kubernetes'),
    (r'\bcubernetes\b',            'Kubernetes'),
    (r'\bkubernetti\b',            'Kubernetes'),
    (r'\bcuber\s*net\s*ees\b',     'Kubernetes'),
    (r'\bhel\s*um\b',              'Helm'),
    (r'\bans\s*ible\b',            'Ansible'),
    # AWS
    (r'\blambada\b',               'Lambda'),
    (r'\biam\b',                   'IAM'),
    (r'\beks\b',                   'EKS'),
    (r'\becs\b',                   'ECS'),
    (r'\bec\s*2\b',                'EC2'),
    (r'\bs\s*3\b',                 'S3'),
    (r'\bvee\s*pc\b',              'VPC'),
    (r'\bcloud\s*formation\b',     'CloudFormation'),
    (r'\bcloud\s*watch\b',         'CloudWatch'),
    (r'\bcloud\s*trail\b',         'CloudTrail'),
    # CI/CD tools
    (r'\bjen\s*kins\b',            'Jenkins'),
    (r'\bargo\s*cd\b',             'ArgoCD'),
    (r'\bgit\s*hub\s*actions\b',   'GitHub Actions'),
    (r'\bgit\s*lab\b',             'GitLab'),
    (r'\bflux\s*cd\b',             'FluxCD'),
    # Monitoring
    (r'\bgraf\s*ana\b',            'Grafana'),
    (r'\bprom\s*etheus\b',         'Prometheus'),
    # General
    (r'\bdev\s*ops\b',             'DevOps'),
    (r'\bdevsec\s*ops\b',          'DevSecOps'),
    (r'\bci\s*cd\b',               'CI/CD'),
    (r'\bmicro\s*services\b',      'microservices'),
    (r'\bfast\s*api\b',            'FastAPI'),
    (r'\bpie\s*thon\b',            'Python'),
]


def correct_transcript(text: str, resume: str | None = None, job_description: str | None = None) -> str:
    corrected = text
    for pattern, replacement in TECH_CORRECTIONS:
        corrected = re.sub(pattern, replacement, corrected, flags=re.IGNORECASE)
    return corrected

SYSTEM_PROMPT = """You are InterviewCopilot, an expert real-time interview coach.

## Conversation memory
This is an ongoing interview. You have the full conversation history.
- Do NOT repeat examples or projects already covered
- Build on the narrative: reference earlier topics naturally
- Understand follow-ups: "tell me more about X" = expand the previous answer, go deeper
- Track which JD requirements have been demonstrated, cover new ones each turn

## Coding problem context
History entries starting with "[Screenshot solve —" mean a coding problem was just solved on screen.
When the interviewer asks follow-up questions like "walk me through your solution", "explain your approach", "what is the time complexity", "why did you choose that data structure" — you have the full solution in the history. Reference it directly and explain it naturally as if the candidate wrote it themselves.

**Line reference questions:** When the interviewer asks about specific lines (e.g. "explain line 7-13", "what does line 5 do", "why line 7"), the history contains the code with line numbers prefixed (e.g. "  7: for i in range..."). Find those exact lines and explain them specifically — what they do, why they were written that way, what would break if removed.

## Transcription intelligence
Speech-to-text makes mistakes. Apply domain inference aggressively:
- DevOps/cloud: tegaform/terraform=Terraform, curbernetes=Kubernetes, eye-am=IAM, see-eye-see-dee=CI/CD, eks=EKS, ecs=ECS
- Backend: rest=REST API, graph-QL=GraphQL, node=Node.js
- Data: spark=Apache Spark, dbt=dbt, redshift=Redshift
If a word sounds like a technology in the JD or resume, that is what was said. Never let a transcription error cause you to misread a question.

## JOB DESCRIPTION - HIGHEST PRIORITY
When provided:
- Use the JD exact technology names, keywords, phrases verbatim
- Map to specific responsibilities listed
- Demonstrate fit for THIS role at THIS company
- Prioritise JD requirements over generic industry language

## RESUME — use as the primary source but not the only source

The resume is the starting point, not a strict boundary. Use this priority order:

1. **Resume experience first** — if the resume has direct experience, lead with it. Real company names, job titles, metrics.
2. **Personal / side projects second** — if the resume doesn't cover it, assume the candidate has explored it personally. e.g. "I've worked with Terraform in personal projects and homelab setups" or "I built a Kubernetes cluster on my home server to learn container orchestration." This is completely normal and valid in interviews.
3. **General knowledge / transferable skills third** — even with zero hands-on experience, the candidate can speak to understanding the concept, its purpose, and how their existing skills transfer. e.g. "I haven't used X in production but I understand it does Y, and my background in Z gives me a strong foundation to pick it up quickly."

**Never say the candidate has no experience with something** — always find the angle. Every tool has concepts that transfer from adjacent experience. A cloud engineer who hasn't used Terraform has used CloudFormation, Pulumi, or CDK — the concepts are identical.

First-person throughout: "I've used...", "In a personal project I...", "I've been experimenting with...", "My background in X means I can..."

## When both JD and resume provided
For each answer: 1) identify which JD requirement is being tested, 2) find the strongest matching resume experience, 3) connect explicitly: My work at X doing Y directly maps to your need for Z

## Response format

**Suggested answer**
Write the FULL answer as if the candidate is speaking it out loud right now. 2-4 sentences. Natural, confident, first-person. This should be something they can read directly.

Example of GOOD suggested answer:
"I've been working with Terraform for the past 4 years, most recently at Acme Corp where I managed multi-account AWS infrastructure as code. I built reusable modules that reduced our provisioning time by 60% and helped us achieve SOC 2 compliance."

Example of BAD suggested answer (DO NOT do this):
"Acknowledge your experience with Terraform. Mention your work at Acme. Highlight your achievements."

**Key points to expand on**
3-5 short bullets of ACTUAL CONTENT the candidate can say — specific facts, numbers, examples. NOT coaching instructions like "mention X" or "acknowledge Y" or "emphasize Z".

Example of GOOD key point:
- "At Acme, I managed 15 AWS accounts using Terraform with remote state in S3 and DynamoDB locking"

Example of BAD key point (DO NOT do this):
- "Acknowledge your experience and highlight relevant skills"

## Edge cases
- Follow-up (tell me more, can you elaborate, why): expand previous answer with more depth, do not start fresh
- Truly no question: respond with only the word Listening"""


def generate_answer(
    transcript: str,
    history: list[dict] | None = None,
    resume: str | None = None,
    job_description: str | None = None,
) -> str:
    if not settings.bedrock_model_id:
        raise RuntimeError("BEDROCK_MODEL_ID is not configured. Set it in backend/.env.")

    client = boto3.client("bedrock-runtime", region_name=settings.aws_region)
    cleaned = correct_transcript(transcript, resume, job_description)

    system_text = SYSTEM_PROMPT
    if job_description or resume:
        system_text += "\n\n---\n## CANDIDATE CONTEXT\n"
    if job_description:
        system_text += f"\n### JOB DESCRIPTION (tailor every answer to this)\n{job_description.strip()}\n"
    if resume:
        system_text += f"\n### CANDIDATE RESUME (ground all examples here)\n{resume.strip()}\n"

    messages = []
    for turn in (history or []):
        q = turn.get("question", "").strip()
        a = turn.get("answer", "").strip()
        if q:
            messages.append({"role": "user",      "content": [{"text": f"Interviewer: {q}"}]})
        if a:
            messages.append({"role": "assistant", "content": [{"text": a}]})

    if cleaned != transcript:
        qtxt = f"Interviewer: {cleaned}\n[corrected from: {transcript!r}]"
    else:
        qtxt = f"Interviewer: {cleaned}"
    messages.append({"role": "user", "content": [{"text": qtxt}]})

    try:
        response = client.converse(
            modelId=settings.bedrock_model_id,
            system=[{"text": system_text}],
            messages=messages,
            inferenceConfig={"maxTokens": settings.model_max_tokens, "temperature": 0.2},
        )
        return "\n".join(
            block["text"] for block in response["output"]["message"]["content"] if "text" in block
        )
    except (BotoCoreError, ClientError) as exc:
        raise RuntimeError(f"Bedrock request failed: {exc}") from exc


CODING_SYSTEM_PROMPT = """You are InterviewCopilot coding assistant. Receive a screenshot of a programming problem.

1. Read problem, constraints, examples, starter code.
2. If no readable problem: say so and stop.
3. Otherwise respond with EXACTLY this structure — no deviations:

**Problem**
1-2 sentence restatement.

**Approach**
- Key idea bullet 1
- Key idea bullet 2

**Solution**
```{language}
// complete runnable code here — MUST be inside the triple-backtick fence
// match the starter code function signature exactly if one is visible
```

**Complexity**
Time: O(...) — one line justification.
Space: O(...) — one line justification.

**Edge cases**
- Edge case 1
- Edge case 2

CRITICAL: The solution code MUST be wrapped in triple backtick fences (```). Never output raw code without fences."""


def _ensure_code_fenced(text: str, language: str) -> str:
    """Post-process: if Bedrock returned code without fences, detect and wrap it."""
    import re
    # Already has a fence — nothing to do
    if '```' in text:
        return text
    # Try to find the Solution section and wrap its content
    solution_match = re.search(
        r'(\*\*Solution\*\*\s*\n)(.*?)(\n\*\*(?:Complexity|Edge cases|Time)|$)',
        text, re.DOTALL | re.IGNORECASE
    )
    if solution_match:
        code_block = solution_match.group(2).strip()
        if code_block:
            fenced = f"```{language.lower()}\n{code_block}\n```"
            text = text[:solution_match.start(2)] + fenced + text[solution_match.end(2):]
    return text


def solve_coding_problem(image: bytes, image_format: str, language: str, notes: str | None = None) -> str:
    if not settings.bedrock_model_id:
        raise RuntimeError("BEDROCK_MODEL_ID is not configured. Set it in backend/.env.")
    client = boto3.client("bedrock-runtime", region_name=settings.aws_region)
    # Inject the language into the system prompt so the fence label is correct
    system_prompt = CODING_SYSTEM_PROMPT.replace("{language}", language.lower())
    prompt = f"Solve the coding problem in this screenshot. Write the solution in {language}. Remember to wrap the code in triple-backtick fences (```)."
    if notes:
        prompt += f"\n\nAdditional notes: {notes.strip()}"
    try:
        response = client.converse(
            modelId=settings.bedrock_model_id,
            system=[{"text": system_prompt}],
            messages=[{"role": "user", "content": [
                {"image": {"format": image_format, "source": {"bytes": image}}},
                {"text": prompt},
            ]}],
            inferenceConfig={"maxTokens": settings.coding_max_tokens, "temperature": 0.1},
        )
        raw = "\n".join(
            block["text"] for block in response["output"]["message"]["content"] if "text" in block
        )
        # Guarantee code is fenced even if Bedrock ignores the instruction
        return _ensure_code_fenced(raw, language)
    except (BotoCoreError, ClientError) as exc:
        raise RuntimeError(f"Bedrock request failed: {exc}") from exc
