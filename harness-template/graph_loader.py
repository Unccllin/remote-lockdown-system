"""
graph_loader.py — Load and validate the GRAPH-SPEC.yaml node graph.

This is the single entry point for reading the graph. All other code
(agent sessions, orchestrator, verification scripts) must use this
loader, not parse the YAML directly.

Usage:
    from graph_loader import load_graph, get_phase, get_debt_items

    graph = load_graph()
    phase3 = get_phase(graph, "P3")
    open_debt = get_debt_items(graph, status="OPEN")

Adapt the accessors if your graph adds new node types. The ones below
cover the 8 mandatory node types in the template.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    raise ImportError(
        "PyYAML is required by graph_loader. Install with: pip install pyyaml"
    )

# ---------------------------------------------------------------------------
# Graph file location
# ---------------------------------------------------------------------------

_GRAPH_SPEC_PATH = Path(__file__).parent / "GRAPH-SPEC.yaml"


def load_graph(path: Path | None = None) -> dict[str, Any]:
    """Load the GRAPH-SPEC.yaml file and return it as a dict.

    Raises FileNotFoundError if the spec doesn't exist.
    Raises yaml.YAMLError if the spec is malformed.
    """
    spec_path = path or _GRAPH_SPEC_PATH
    if not spec_path.exists():
        raise FileNotFoundError(f"GRAPH-SPEC.yaml not found at {spec_path}")
    with open(spec_path) as f:
        graph = yaml.safe_load(f)
    if not graph:
        raise ValueError(f"GRAPH-SPEC.yaml at {spec_path} is empty or invalid")
    return graph


# ---------------------------------------------------------------------------
# Accessors
# ---------------------------------------------------------------------------


def get_session_nodes(graph: dict) -> list[dict]:
    """Return the session lifecycle nodes."""
    return graph.get("session_nodes", [])


def get_session_edges(graph: dict) -> list[dict]:
    """Return the session lifecycle edges (allowed transitions)."""
    return graph.get("session_edges", [])


def get_phase_nodes(graph: dict) -> list[dict]:
    """Return all phase nodes."""
    return graph.get("phase_nodes", [])


def get_phase(graph: dict, phase_id: str) -> dict | None:
    """Return a single phase node by ID (e.g., 'P3')."""
    for phase in get_phase_nodes(graph):
        if phase["id"] == phase_id:
            return phase
    return None


def get_phase_deps(graph: dict, phase_id: str) -> list[str]:
    """Return the dependency list for a phase."""
    phase = get_phase(graph, phase_id)
    return phase.get("deps", []) if phase else []


def get_verification_nodes(graph: dict) -> list[dict]:
    """Return all verification nodes."""
    return graph.get("verification_nodes", [])


def get_verification_node(graph: dict, node_id: str) -> dict | None:
    """Return a single verification node by ID."""
    for node in get_verification_nodes(graph):
        if node["id"] == node_id:
            return node
    return None


def get_enforcement_paths(graph: dict) -> list[dict]:
    """Return all enforcement path nodes."""
    return graph.get("enforcement_paths", [])


def get_enforcement_path(graph: dict, path_id: str) -> dict | None:
    """Return a single enforcement path by ID."""
    for path in get_enforcement_paths(graph):
        if path["id"] == path_id:
            return path
    return None


def get_component_nodes(graph: dict) -> list[dict]:
    """Return all component nodes."""
    return graph.get("component_nodes", [])


def get_debt_items(graph: dict, status: str | None = None) -> list[dict]:
    """Return debt items, optionally filtered by status ('OPEN' or 'CLOSED')."""
    items = graph.get("debt_items", [])
    if status:
        return [item for item in items if item.get("status") == status]
    return items


def get_debt_item(graph: dict, debt_id: str) -> dict | None:
    """Return a single debt item by ID."""
    for item in get_debt_items(graph):
        if item["id"] == debt_id:
            return item
    return None


def get_invariants(graph: dict) -> list[dict]:
    """Return all graph invariants (rules enforced by graph_assert.py)."""
    return graph.get("invariants", [])


def get_open_debt_items(graph: dict) -> list[dict]:
    """Return all debt items with status OPEN."""
    return get_debt_items(graph, status="OPEN")


def get_closed_debt_items(graph: dict) -> list[dict]:
    """Return all debt items with status CLOSED."""
    return get_debt_items(graph, status="CLOSED")


def get_blocked_enforcement_paths(graph: dict) -> list[dict]:
    """Return enforcement paths that are blocked by open debt items."""
    open_debt = get_open_debt_items(graph)
    blocked_ids = set()
    for debt in open_debt:
        for block_id in debt.get("blocks", []):
            blocked_ids.add(block_id)
    return [path for path in get_enforcement_paths(graph) if path["id"] in blocked_ids]


def get_phase_status(graph: dict, phase_id: str) -> str:
    """Return the status of a phase ('COMPLETE', 'IN_PROGRESS', 'PENDING')."""
    phase = get_phase(graph, phase_id)
    return phase.get("status", "PENDING") if phase else "UNKNOWN"


def are_phase_deps_met(graph: dict, phase_id: str) -> bool:
    """Check if all dependencies of a phase are COMPLETE."""
    deps = get_phase_deps(graph, phase_id)
    return all(get_phase_status(graph, dep) == "COMPLETE" for dep in deps)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    graph = load_graph()
    print("=== Node Graph ===")
    print(f"Phases: {len(get_phase_nodes(graph))}")
    print(f"Verification nodes: {len(get_verification_nodes(graph))}")
    print(f"Enforcement paths: {len(get_enforcement_paths(graph))}")
    print(f"Components: {len(get_component_nodes(graph))}")
    print(
        f"Debt items: {len(get_debt_items(graph))} "
        f"({len(get_open_debt_items(graph))} open, "
        f"{len(get_closed_debt_items(graph))} closed)"
    )
    print(f"Invariants: {len(get_invariants(graph))}")
    print()
    print("Open debt items:")
    for debt in get_open_debt_items(graph):
        blocks = ", ".join(debt.get("blocks", [])) or "—"
        print(f"  {debt['id']}: {debt.get('description', '—')[:60]}  [blocks: {blocks}]")
    print()
    print("Blocked enforcement paths:")
    for path in get_blocked_enforcement_paths(graph):
        print(f"  {path['id']} ({path['name']}): {path.get('risk_notes', '—')[:60]}")
