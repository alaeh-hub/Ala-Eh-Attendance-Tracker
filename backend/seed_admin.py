"""
Run once to create the first admin account:
    python seed_admin.py admin@example.com "Admin User" your-password
"""
import sys
from app import create_app
from app.services.auth_service import register_user

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python seed_admin.py <email> <full_name> <password>")
        sys.exit(1)

    email, full_name, password = sys.argv[1], sys.argv[2], sys.argv[3]
    app = create_app()
    with app.app_context():
        user = register_user(full_name, email, password, role="ADMIN")
        print(f"Created admin: {user.email} (id={user.id})")
