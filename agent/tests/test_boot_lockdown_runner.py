"""S265: the boot-lockdown status runner referenced a symbol that no longer exists.

`cmd_status()` used `hp_uefi_lockdown.LOCKDOWN_SETTINGS`, which D-009 replaced with
model-aware resolution (`_resolve_setting_names()`). Nothing imports this runner, and
no test covered it, so the AttributeError would have surfaced on the first HP machine
someone ran `--status` against — the exact machine where the output matters.

The structural test below checks *every* `hp_uefi_lockdown.<name>` / `bcd_lockdown.<name>`
reference in the runner, so the next rename in either module fails here instead of on
hardware.
"""

import re
import sys
from pathlib import Path

_AGENT_DIR = Path(__file__).parent.parent
if str(_AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AGENT_DIR))

import bcd_lockdown  # noqa: E402
import boot_lockdown_test_runner  # noqa: E402
import hp_uefi_lockdown  # noqa: E402

MODULES = {
    "hp_uefi_lockdown": hp_uefi_lockdown,
    "bcd_lockdown": bcd_lockdown,
}


def _referenced_symbols() -> list[tuple[str, str]]:
    source = Path(boot_lockdown_test_runner.__file__).read_text()
    refs = []
    for module_name in MODULES:
        pattern = rf"\b{module_name}\.([A-Za-z_]\w*)"
        refs.extend((module_name, name) for name in re.findall(pattern, source))
    return refs


def test_every_referenced_module_symbol_exists():
    missing = [
        f"{module_name}.{name}"
        for module_name, name in _referenced_symbols()
        if not hasattr(MODULES[module_name], name)
    ]
    assert not missing, f"boot_lockdown_test_runner references symbols that do not exist: {missing}"


def test_status_command_runs_and_prints_resolved_setting_names(monkeypatch, capsys):
    monkeypatch.setattr(hp_uefi_lockdown, "is_hp_machine", lambda: True)
    monkeypatch.setattr(
        hp_uefi_lockdown, "_resolve_setting_names", lambda: ([("DMA Protection", "enabled")], [])
    )
    monkeypatch.setattr(hp_uefi_lockdown, "_read_setting", lambda name: "Enabled")

    boot_lockdown_test_runner.cmd_status()

    out = capsys.readouterr().out
    assert "DMA Protection: Enabled" in out
