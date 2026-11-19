"""Outgoing mail (password reset). Without SMTP settings the message is logged instead of sent."""
from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage

from .. import config

log = logging.getLogger("godownbook")


def send_mail(to: str, subject: str, body: str) -> bool:
    s = config.smtp_settings()
    if not s["host"]:
        log.warning("SMTP not configured; mail to %s not sent.\nSubject: %s\n%s", to, subject, body)
        return False
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = s["sender"] or "no-reply@localhost", to, subject
    msg.set_content(body)
    try:
        with smtplib.SMTP(s["host"], s["port"], timeout=15) as smtp:
            smtp.starttls()
            if s["user"]:
                smtp.login(s["user"], s["password"])
            smtp.send_message(msg)
        return True
    except Exception:  # noqa: BLE001 - never surface mail failures to the requester
        log.exception("Could not send mail to %s", to)
        return False
