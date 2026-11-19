// Package economy contains deterministic, currency-safe virtual-economy rules.
// Monetary values are integer tetri (1 GEL = 100 tetri); floating point is forbidden.
package economy

import (
	"errors"
	"fmt"
	"math/big"
)

var (
	ErrNegativeGross      = errors.New("gross amount cannot be negative")
	ErrInvalidAllowance   = errors.New("tax-free allowance cannot be negative")
	ErrInvalidTaxSchedule = errors.New("tax schedule must contain contiguous, ascending brackets ending in an open bracket")
	ErrInvalidTaxRate     = errors.New("tax rate must be between 0 and 10000 basis points")
)

// TaxBracket is a marginal band. UpToTetri is an exclusive upper boundary;
// zero means the final, unbounded bracket. The first bracket starts at zero.
type TaxBracket struct {
	UpToTetri int64 `json:"up_to_tetri"`
	RateBPS   int64 `json:"rate_bps"`
}

// TaxPolicy is a versioned policy input. Rates are deliberately supplied by
// configuration: this package does not invent or hard-code Georgian tax rates.
type TaxPolicy struct {
	Code                  string       `json:"code"`
	Version               int          `json:"version"`
	TaxFreeAllowanceTetri int64        `json:"tax_free_allowance_tetri"`
	Brackets              []TaxBracket `json:"brackets"`
}

type TaxAssessment struct {
	GrossTetri     int64 `json:"gross_tetri"`
	AllowanceTetri int64 `json:"allowance_tetri"`
	TaxableTetri   int64 `json:"taxable_tetri"`
	TaxTetri       int64 `json:"tax_tetri"`
	NetTetri       int64 `json:"net_tetri"`
	PolicyVersion  int   `json:"policy_version"`
}

func (p TaxPolicy) Validate() error {
	if p.TaxFreeAllowanceTetri < 0 {
		return ErrInvalidAllowance
	}
	if p.Code == "" || len(p.Code) > 64 || p.Version < 1 || len(p.Brackets) == 0 {
		return ErrInvalidTaxSchedule
	}
	var previous int64
	for i, b := range p.Brackets {
		if b.RateBPS < 0 || b.RateBPS > 10000 {
			return ErrInvalidTaxRate
		}
		if i < len(p.Brackets)-1 {
			if b.UpToTetri <= previous {
				return ErrInvalidTaxSchedule
			}
			previous = b.UpToTetri
		} else if b.UpToTetri != 0 {
			return ErrInvalidTaxSchedule
		}
	}
	return nil
}

// AssessTax calculates marginal tax using integer arithmetic and rounds the
// total tax once, half-up, to the nearest tetri. This avoids float drift.
func AssessTax(grossTetri int64, policy TaxPolicy) (TaxAssessment, error) {
	if grossTetri < 0 {
		return TaxAssessment{}, ErrNegativeGross
	}
	if err := policy.Validate(); err != nil {
		return TaxAssessment{}, err
	}
	allowance := policy.TaxFreeAllowanceTetri
	if allowance > grossTetri {
		allowance = grossTetri
	}
	taxable := grossTetri - allowance
	remaining, lower := taxable, int64(0)
	numerator := new(big.Int)
	for _, bracket := range policy.Brackets {
		if remaining == 0 {
			break
		}
		width := remaining
		if bracket.UpToTetri != 0 {
			bandWidth := bracket.UpToTetri - lower
			if bandWidth < width {
				width = bandWidth
			}
		}
		if width < 0 {
			return TaxAssessment{}, ErrInvalidTaxSchedule
		}
		term := new(big.Int).Mul(big.NewInt(width), big.NewInt(bracket.RateBPS))
		numerator.Add(numerator, term)
		remaining -= width
		if bracket.UpToTetri != 0 {
			lower = bracket.UpToTetri
		}
	}
	if remaining != 0 {
		return TaxAssessment{}, ErrInvalidTaxSchedule
	}
	numerator.Add(numerator, big.NewInt(5000))
	numerator.Quo(numerator, big.NewInt(10000))
	if !numerator.IsInt64() {
		return TaxAssessment{}, fmt.Errorf("tax result exceeds supported tetri range")
	}
	tax := numerator.Int64()
	if tax > taxable {
		tax = taxable
	}
	return TaxAssessment{GrossTetri:grossTetri, AllowanceTetri:allowance, TaxableTetri:taxable, TaxTetri:tax, NetTetri:grossTetri-tax, PolicyVersion:policy.Version}, nil
}
