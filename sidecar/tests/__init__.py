"""Marks the suite as a regular package so `tests.conftest` always means this folder, even when a third-party
package installed a top-level `tests` into site-packages (which would otherwise shadow it)."""
