import pandas as pd
import pytest

from bearings.sources import socrata


def test_fetch_returns_a_dataframe():
    df = socrata.fetch("restaurants", limit=5)
    assert isinstance(df, pd.DataFrame)
    assert len(df) == 5


def test_select_narrows_columns():
    df = socrata.fetch("restaurants", select="dba,boro", limit=3)
    assert set(df.columns) == {"dba", "boro"}


def test_where_filters_rows():
    df = socrata.fetch("restaurants", select="boro", where="boro='Manhattan'", limit=10)
    assert (df["boro"] == "Manhattan").all()


def test_paginates_past_the_50k_cap():
    # Ask for more than one page and confirm we actually get more than one page.
    df = socrata.fetch("restaurants", select="camis", limit=50_001)
    assert len(df) > 50_000


def test_unknown_dataset_key_raises():
    with pytest.raises(KeyError):
        socrata.fetch("not_a_dataset")
