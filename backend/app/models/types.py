"""Column types that behave the same on SQLite, PostgreSQL and MySQL.

MySQL's plain defaults are too small or too coarse for this schema:

- ``BLOB`` holds 64 KB, but a scan snapshot is a 640px JPEG (often larger);
- ``DATETIME`` drops fractional seconds, and punches are ordered (and the
  re-scan cooldown measured) by timestamp, so two punches in one second
  would tie;
- ``TEXT`` holds 64 KB; audit trails and JSON blobs get ``MEDIUMTEXT``.

Other databases keep their ordinary types (the variants apply to MySQL only).
"""
from sqlalchemy import DateTime, LargeBinary, Text
from sqlalchemy.dialects import mysql

Blob = LargeBinary().with_variant(mysql.LONGBLOB(), "mysql")
UtcDateTime = DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")  # naive UTC, microseconds
LongText = Text().with_variant(mysql.MEDIUMTEXT(), "mysql")
