package economy

import (
	"errors"
	"testing"
)

func TestAssessTaxFlatRateAndRounding(t *testing.T) {
	policy := TaxPolicy{Code:"test_flat", Version:1, Brackets:[]TaxBracket{{RateBPS:1500}}}
	got, err := AssessTax(101, policy)
	if err != nil { t.Fatal(err) }
	if got.TaxTetri != 15 || got.NetTetri != 86 { t.Fatalf("unexpected assessment: %+v", got) }
	got, err = AssessTax(1, policy)
	if err != nil { t.Fatal(err) }
	if got.TaxTetri != 0 { t.Fatalf("unexpected rounding: %+v", got) }
}

func TestAssessTaxProgressiveMarginalBands(t *testing.T) {
	policy := TaxPolicy{Code:"test_progressive", Version:3, TaxFreeAllowanceTetri:10000, Brackets:[]TaxBracket{
		{UpToTetri:100000, RateBPS:1000},
		{UpToTetri:200000, RateBPS:2000},
		{RateBPS:3000},
	}}
	got, err := AssessTax(260000, policy)
	if err != nil { t.Fatal(err) }
	if got.TaxableTetri != 250000 || got.TaxTetri != 45000 || got.NetTetri != 215000 {
		t.Fatalf("unexpected progressive assessment: %+v", got)
	}
}

func TestAssessTaxAllowanceExceedsGross(t *testing.T) {
	policy := TaxPolicy{Code:"allowance", Version:1, TaxFreeAllowanceTetri:500, Brackets:[]TaxBracket{{RateBPS:2500}}}
	got, err := AssessTax(100, policy)
	if err != nil { t.Fatal(err) }
	if got.AllowanceTetri != 100 || got.TaxableTetri != 0 || got.TaxTetri != 0 || got.NetTetri != 100 {
		t.Fatalf("unexpected allowance assessment: %+v", got)
	}
}

func TestAssessTaxRejectsInvalidInputs(t *testing.T) {
	valid := TaxPolicy{Code:"valid", Version:1, Brackets:[]TaxBracket{{RateBPS:1000}}}
	if _, err := AssessTax(-1, valid); !errors.Is(err, ErrNegativeGross) { t.Fatalf("got %v", err) }
	badRate := TaxPolicy{Code:"bad", Version:1, Brackets:[]TaxBracket{{RateBPS:10001}}}
	if _, err := AssessTax(100, badRate); !errors.Is(err, ErrInvalidTaxRate) { t.Fatalf("got %v", err) }
	badAllowance := TaxPolicy{Code:"bad_allowance", Version:1, TaxFreeAllowanceTetri:-1, Brackets:[]TaxBracket{{RateBPS:1000}}}
	if _, err := AssessTax(100, badAllowance); !errors.Is(err, ErrInvalidAllowance) { t.Fatalf("got %v", err) }
	gap := TaxPolicy{Code:"gap", Version:1, Brackets:[]TaxBracket{{UpToTetri:100, RateBPS:1000}, {UpToTetri:200, RateBPS:2000}}}
	if _, err := AssessTax(100, gap); !errors.Is(err, ErrInvalidTaxSchedule) { t.Fatalf("got %v", err) }
}

func TestAssessTaxLargeAmounts(t *testing.T) {
	policy := TaxPolicy{Code:"large", Version:1, Brackets:[]TaxBracket{{RateBPS:9999}}}
	got, err := AssessTax(9000000000000001, policy)
	if err != nil { t.Fatal(err) }
	if got.TaxTetri <= 0 || got.NetTetri <= 0 || got.TaxTetri+got.NetTetri != got.GrossTetri {
		t.Fatalf("unexpected assessment: %+v", got)
	}
}
