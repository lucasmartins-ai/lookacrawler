package csvsafe

import "testing"

func TestCellNeutralizesFormulaPrefixes(t *testing.T) {
	for _, input := range []string{"=1+1", "+cmd", "-2+3", "@SUM(A1)", "\t=1", "\r=1"} {
		got := Cell(input)
		if got == input || len(got) == 0 || got[0] != '\'' {
			t.Fatalf("Cell(%q)=%q", input, got)
		}
	}
	if got := Cell("ordinary"); got != "ordinary" {
		t.Fatalf("ordinary=%q", got)
	}
}
