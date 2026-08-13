# T3: Phase 1 — VT-d/IOMMU DMA protection via HP WMI

> **Label:** `wayfinder:task`
> **Status:** OPEN
> **Blocks:** none
> **Blocked by:** none
> **Implements:** Q6

## Question

Enable VT-d/IOMMU DMA protection via HP WMI to close Thunderbolt/PCIe DMA
attacks.

## Work

1. Add `dma_protection` and `vtd` concepts to `CONCEPTS` and
   `DEFAULT_SETTING_NAMES` in `agent/hp_uefi_lockdown.py`.
2. Candidate setting names: "VT-d", "Intel VT-d", "Virtualization Technology
   for Directed I/O", "IOMMU", "DMA Protection".
3. Add as a best-effort setting (Enable) — not all HP models support it.
4. Include in the lockdown result dict: `dma_protection_applied: int`.
5. Add to dry-run BIOS state.
6. Write tests (mocked).

## Files to edit

- `agent/hp_uefi_lockdown.py` (add dma_protection/vtd concepts, setting names,
  include in best-effort settings)
- `agent/tests/test_boot_lockdown.py` (add tests for DMA protection)

## Acceptance

- VT-d/DMA protection is attempted as a best-effort setting.
- Result dict includes DMA protection status.
- Tests pass (mocked). Ruff clean.
