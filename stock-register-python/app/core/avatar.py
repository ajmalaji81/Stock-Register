"""Profile pictures are stored as small data: URLs (256x256, resized in the browser)."""
import re
from typing import Optional

AVATAR_SIZE = 256
AVATAR_MAX_CHARS = 150_000
_DATA_URL = re.compile(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$")


def avatar_error(value: str) -> Optional[str]:
    if len(value) > AVATAR_MAX_CHARS:
        return "Picture is too large. Please choose a smaller image."
    if not _DATA_URL.match(value):
        return "Picture must be a PNG, JPEG or WebP image."
    return None
