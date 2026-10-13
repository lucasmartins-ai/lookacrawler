package safehttp

import (
	"context"
	"net/netip"
	"net/url"
	"testing"
)

type resolver map[string][]netip.Addr

func (r resolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	return r[host], nil
}

func TestValidateURLBlocksPrivateMixedAndUserInfo(t *testing.T) {
	ports := map[string]bool{"80": true, "443": true}
	cases := []string{"http://127.0.0.1", "http://169.254.169.254/latest", "http://user:pass@example.com", "file:///etc/passwd", "https://example.com:8443"}
	for _, raw := range cases {
		u, _ := url.Parse(raw)
		if ValidateURL(context.Background(), u, resolver{"example.com": {netip.MustParseAddr("93.184.216.34")}}, ports) == nil {
			t.Fatalf("expected block: %s", raw)
		}
	}
	u, _ := url.Parse("https://mixed.example")
	if ValidateURL(context.Background(), u, resolver{"mixed.example": {netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("10.0.0.1")}}, ports) == nil {
		t.Fatal("mixed DNS answer must be blocked")
	}
	u, _ = url.Parse("https://public.example/path")
	if err := ValidateURL(context.Background(), u, resolver{"public.example": {netip.MustParseAddr("93.184.216.34")}}, ports); err != nil {
		t.Fatal(err)
	}
}
