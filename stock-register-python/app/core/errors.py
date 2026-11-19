class StockError(Exception):
    """Expected, user-facing failure. Becomes {"error": message, "code": code} with `status`."""

    def __init__(self, message: str, status: int = 400, code: str | None = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
