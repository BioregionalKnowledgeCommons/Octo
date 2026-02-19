#!/usr/bin/env python3
"""
Encrypt an existing unencrypted PEM private key with a password.

Usage:
    PRIV_KEY_PASSWORD=<password> python encrypt_private_key.py <path_to_key.pem>

What it does:
    1. Reads existing unencrypted PEM
    2. Backs up original to {path}.unencrypted.bak
    3. Writes encrypted PEM to same path
    4. Verifies public key unchanged post-encryption

Rollback:
    cp {path}.unencrypted.bak {path}
    # Remove PRIV_KEY_PASSWORD from env
    # Restart service
"""

import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def main():
    if len(sys.argv) != 2:
        print(f"Usage: PRIV_KEY_PASSWORD=<pw> {sys.argv[0]} <path_to_key.pem>")
        sys.exit(1)

    key_path = Path(sys.argv[1])
    password = os.getenv("PRIV_KEY_PASSWORD")

    if not password:
        print("ERROR: PRIV_KEY_PASSWORD environment variable not set")
        sys.exit(1)

    if not key_path.exists():
        print(f"ERROR: Key file not found: {key_path}")
        sys.exit(1)

    # Load unencrypted key
    pem_data = key_path.read_bytes()
    try:
        private_key = serialization.load_pem_private_key(data=pem_data, password=None)
    except TypeError:
        print("ERROR: Key appears to already be encrypted (requires password to load)")
        sys.exit(1)

    # Record public key before encryption
    pub_before = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    # Backup original
    backup_path = key_path.with_suffix(key_path.suffix + ".unencrypted.bak")
    if backup_path.exists():
        print(f"WARNING: Backup already exists at {backup_path}, skipping backup")
    else:
        backup_path.write_bytes(pem_data)
        os.chmod(backup_path, 0o600)
        print(f"Backed up original to {backup_path}")

    # Write encrypted key
    encrypted_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.BestAvailableEncryption(password.encode()),
    )
    key_path.write_bytes(encrypted_pem)
    os.chmod(key_path, 0o600)
    print(f"Encrypted key written to {key_path}")

    # Verify: reload encrypted key and check public key unchanged
    reloaded = serialization.load_pem_private_key(
        data=key_path.read_bytes(),
        password=password.encode(),
    )
    pub_after = reloaded.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    if pub_before != pub_after:
        print("CRITICAL: Public key changed after encryption! Restoring backup.")
        key_path.write_bytes(pem_data)
        sys.exit(1)

    print("Verified: public key unchanged after encryption")
    print("Done. Key is now encrypted with PRIV_KEY_PASSWORD.")
    print(f"Rollback: cp {backup_path} {key_path}")


if __name__ == "__main__":
    main()
