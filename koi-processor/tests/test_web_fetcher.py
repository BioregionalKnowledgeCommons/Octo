"""Tests for api/web_fetcher.py — URL validation and SSRF protection."""

import pytest

from api.web_fetcher import URLValidator, URLValidationError, generate_web_rid


# =============================================================================
# URLValidator — SSRF protection
# =============================================================================


class TestURLValidator:
    def setup_method(self):
        self.validator = URLValidator()

    def test_validate_url_https_passes(self):
        result = self.validator.validate("https://example.com/article")
        assert result == "https://example.com/article"

    def test_validate_url_adds_https_if_missing(self):
        result = self.validator.validate("example.com/page")
        assert result.startswith("https://")

    def test_validate_blocks_file_scheme(self):
        with pytest.raises(URLValidationError, match="Blocked scheme"):
            self.validator.validate("file:///etc/passwd")

    def test_validate_blocks_ftp_scheme(self):
        with pytest.raises(URLValidationError, match="Blocked scheme"):
            self.validator.validate("ftp://files.example.com/data")

    def test_validate_blocks_data_scheme(self):
        with pytest.raises(URLValidationError, match="Blocked scheme"):
            self.validator.validate("data:text/html,<h1>hi</h1>")

    def test_validate_blocks_javascript_scheme(self):
        with pytest.raises(URLValidationError, match="Blocked scheme"):
            self.validator.validate("javascript:alert(1)")

    def test_validate_blocks_metadata_ip(self):
        with pytest.raises(URLValidationError, match="Blocked"):
            self.validator.validate("http://169.254.169.254/latest/meta-data/")

    def test_validate_blocks_metadata_host(self):
        with pytest.raises(URLValidationError, match="Blocked host"):
            self.validator.validate("http://metadata.google.internal/v1/")

    def test_validate_blocks_private_10(self):
        with pytest.raises(URLValidationError, match="Blocked private IP"):
            self.validator.validate("http://10.0.0.1/admin")

    def test_validate_blocks_localhost(self):
        with pytest.raises(URLValidationError, match="Blocked private IP"):
            self.validator.validate("http://127.0.0.1/secret")

    def test_validate_blocks_private_172(self):
        with pytest.raises(URLValidationError, match="Blocked private IP"):
            self.validator.validate("http://172.16.0.1/internal")

    def test_validate_blocks_private_192(self):
        with pytest.raises(URLValidationError, match="Blocked private IP"):
            self.validator.validate("http://192.168.1.1/router")

    def test_validate_no_hostname(self):
        with pytest.raises(URLValidationError):
            self.validator.validate("http://")


# =============================================================================
# generate_web_rid
# =============================================================================


def test_generate_web_rid_format():
    rid = generate_web_rid("https://example.com/article")
    assert rid.startswith("orn:web.page:")
    assert "example_com" in rid


def test_generate_web_rid_deterministic():
    rid1 = generate_web_rid("https://example.com/page")
    rid2 = generate_web_rid("https://example.com/page")
    assert rid1 == rid2


def test_generate_web_rid_varies_with_url():
    rid1 = generate_web_rid("https://example.com/page1")
    rid2 = generate_web_rid("https://example.com/page2")
    assert rid1 != rid2
