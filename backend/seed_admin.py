"""
Run once to create the first admin account:
    python seed_admin.py admin@example.com "Admin User"
The password is prompted for (not echoed). It may also be given as a third
argument, but that leaves it in the shell history and the process list.
"""
import getpass
import sys

from app import create_app
from app.services.auth_service import register_user
from app.utils.validators import is_valid_email, is_valid_password

if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        print("Usage: python seed_admin.py <email> <full_name> [password]")
        sys.exit(1)

    email, full_name = sys.argv[1].strip().lower(), sys.argv[2].strip()
    password = sys.argv[3] if len(sys.argv) == 4 else getpass.getpass("Password (8-72 characters): ")
    if not is_valid_email(email):
        sys.exit("Invalid email address.")
    if not full_name or len(full_name) > 120:
        sys.exit("A full name of up to 120 characters is required.")
    if not is_valid_password(password):
        sys.exit("Password must be 8 to 72 characters long.")

    app = create_app()
    with app.app_context():
        user = register_user(full_name, email, password, role="ADMIN")
        print(f"Created admin: {user.email} (id={user.id})")
