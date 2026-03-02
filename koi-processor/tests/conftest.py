"""Shared pytest configuration for KOI-net and web pipeline tests."""

import pytest
from unittest.mock import AsyncMock


# =============================================================================
# CLI options and markers
# =============================================================================


def pytest_addoption(parser):
    parser.addoption(
        "--live-url",
        default=None,
        help="KOI API base URL for live conformance tests (e.g. http://127.0.0.1:8351)",
    )


def pytest_configure(config):
    config.addinivalue_line("markers", "live: requires a running KOI API instance (--live-url)")


@pytest.fixture
def live_url(request):
    url = request.config.getoption("--live-url")
    if url is None:
        pytest.skip("--live-url not provided")
    return url.rstrip("/")


# =============================================================================
# Mock DB fixtures (shared across test modules)
# =============================================================================


class MockConn:
    """Lightweight mock for asyncpg.Connection with query-matching results."""

    def __init__(self, fetchrow_results=None, fetch_results=None):
        self.fetchrow_results = fetchrow_results or {}
        self.fetch_results = fetch_results or {}
        self.executed = []

    async def fetchrow(self, query, *args):
        for key, val in self.fetchrow_results.items():
            if key in query:
                return val
        return None

    async def fetch(self, query, *args):
        for key, val in self.fetch_results.items():
            if key in query:
                return val
        return []

    async def fetchval(self, query, *args):
        return 0

    async def execute(self, query, *args):
        self.executed.append((query, args))


class MockPool:
    """Mock for asyncpg.Pool with acquire() context manager."""

    def __init__(self, conn=None):
        self.conn = conn or MockConn()

    def acquire(self):
        return MockPoolContext(self.conn)


class MockPoolContext:
    """Async context manager for MockPool.acquire()."""

    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *args):
        pass


@pytest.fixture
def mock_conn():
    return MockConn()


@pytest.fixture
def mock_pool(mock_conn):
    return MockPool(mock_conn)
