"""production hardening: token revocation and work-day attendance stamps

- users.token_version: bumped to revoke every session of a user.
- revoked_tokens: JWT blocklist for logout / kiosk lock.
- attendance_events.work_date / scheduled_* / late_minutes / early_minutes:
  lateness stamped at write time so later schedule edits don't rewrite
  history. Legacy rows stay NULL and are computed at read time.

Each step skips objects that already exist: development databases (and
legacy ones adopted at the baseline) may already have them via
app/schema_upgrade.py.

Revision ID: 0002_hardening
Revises: 0001_baseline
Create Date: 2026-10-14 13:17:03.258052

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '0002_hardening'
down_revision = '0001_baseline'
branch_labels = None
depends_on = None

_EVENT_COLUMNS = [
    sa.Column('work_date', sa.Date(), nullable=True),
    sa.Column('scheduled_start', sa.String(length=5), nullable=True),
    sa.Column('scheduled_end', sa.String(length=5), nullable=True),
    sa.Column('late_minutes', sa.Integer(), nullable=True),
    sa.Column('early_minutes', sa.Integer(), nullable=True),
]


def _existing():
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())

    def columns(table):
        return {c['name'] for c in inspector.get_columns(table)}

    def indexes(table):
        return {i['name'] for i in inspector.get_indexes(table)}

    return tables, columns, indexes


def upgrade():
    tables, columns, indexes = _existing()

    if 'revoked_tokens' not in tables:
        op.create_table('revoked_tokens',
        sa.Column('jti', sa.String(length=36), nullable=False),
        sa.Column('token_type', sa.String(length=10), nullable=False),
        sa.Column('user_id', sa.String(length=36), nullable=True),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.Column('revoked_at', sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint('jti')
        )
    token_indexes = indexes('revoked_tokens') if 'revoked_tokens' in tables else set()
    with op.batch_alter_table('revoked_tokens', schema=None) as batch_op:
        if 'ix_revoked_tokens_expires_at' not in token_indexes:
            batch_op.create_index(batch_op.f('ix_revoked_tokens_expires_at'), ['expires_at'], unique=False)
        if 'ix_revoked_tokens_user_id' not in token_indexes:
            batch_op.create_index(batch_op.f('ix_revoked_tokens_user_id'), ['user_id'], unique=False)

    event_columns = columns('attendance_events')
    with op.batch_alter_table('attendance_events', schema=None) as batch_op:
        for column in _EVENT_COLUMNS:
            if column.name not in event_columns:
                batch_op.add_column(column.copy())
        if 'ix_attendance_events_work_date' not in indexes('attendance_events'):
            batch_op.create_index(batch_op.f('ix_attendance_events_work_date'), ['work_date'], unique=False)

    if 'token_version' not in columns('users'):
        with op.batch_alter_table('users', schema=None) as batch_op:
            batch_op.add_column(sa.Column('token_version', sa.Integer(), server_default='0', nullable=False))


def downgrade():
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('token_version')

    with op.batch_alter_table('attendance_events', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_attendance_events_work_date'))
        for column in reversed(_EVENT_COLUMNS):
            batch_op.drop_column(column.name)

    with op.batch_alter_table('revoked_tokens', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_revoked_tokens_user_id'))
        batch_op.drop_index(batch_op.f('ix_revoked_tokens_expires_at'))

    op.drop_table('revoked_tokens')
