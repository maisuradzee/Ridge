# RIDGE increment 2.8 — deterministic virtual tax calculation

Date: 2026-11-19

## Implemented

- Added a standalone Go tax-calculation domain package at `backend/internal/economy`.
- All monetary inputs and outputs are integer tetri (100 tetri = 1 GEL); floating-point arithmetic is not used.
- Supports configurable progressive marginal brackets, a configurable tax-free allowance, and versioned policy inputs.
- Computes total tax using integer big-number arithmetic and rounds once, half-up, to the nearest tetri.
- Validates ascending brackets, requires a final open-ended bracket, and rejects rates outside 0–10000 basis points.
- Tax rates are not hard-coded. The package deliberately does not assume Georgian tax rates or make legal/tax-policy decisions.
- Includes tests for flat and progressive rates, allowance handling, validation failures, rounding, and large values.

## Verification

- `go test ./...` — PASS
- `go test -race ./...` — PASS
- `go vet ./...` — PASS
- `go build ./...` — PASS

## Scope and integration boundary

This increment is a deterministic calculation library only. It does not debit player wallets, create tax liabilities, file returns, move company funds, or persist assessments. No tax policy rates have been selected. Before production use, policy versions, taxable events, exemptions, assessment persistence, appeals/corrections, and wallet/company settlement must be implemented and validated against applicable legal and game-economy rules. Player and company money must remain separate.
