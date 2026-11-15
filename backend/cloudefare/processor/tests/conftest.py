import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpers import RangeServer, Sink, make_gcov, make_gunw  # noqa: E402


@pytest.fixture(scope="session")
def gcov_file(tmp_path_factory):
    return make_gcov(tmp_path_factory.mktemp("h5") / "gcov.h5")


@pytest.fixture(scope="session")
def gunw_file(tmp_path_factory):
    return make_gunw(tmp_path_factory.mktemp("h5") / "gunw.h5")


@pytest.fixture
def sink():
    s = Sink()
    yield s
    s.close()


@pytest.fixture
def range_server(gcov_file):
    s = RangeServer(gcov_file)
    yield s
    s.close()
