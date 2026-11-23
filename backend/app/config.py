from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    aws_region: str = "us-east-1"
    bedrock_model_id: str = ""
    frontend_origin: str = "http://localhost:5173"
    desktop_origin: str = "app://interview-copilot"
    language_code: str = "en-US"
    model_max_tokens: int = 1200
    coding_max_tokens: int = 3000

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
