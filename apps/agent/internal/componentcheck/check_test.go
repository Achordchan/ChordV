package componentcheck

import (
	"archive/zip"
	"github.com/xtls/xray-core/app/router"
	"google.golang.org/protobuf/proto"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestRules(t *testing.T) {
	ip, _ := proto.Marshal(&router.GeoIPList{Entry: []*router.GeoIP{{CountryCode: "CN", Cidr: []*router.CIDR{{Ip: []byte{1, 2, 3, 0}, Prefix: 24}}}}})
	site, _ := proto.Marshal(&router.GeoSiteList{Entry: []*router.GeoSite{{CountryCode: "TEST", Domain: []*router.Domain{{Type: router.Domain_Domain, Value: "example.com"}}}}})
	for _, kind := range []string{"geoip", "geosite"} {
		for _, data := range [][]byte{nil, []byte("garbage"), {0x0a, 0x00}, {0xff}} {
			if ValidateRules(data, kind) == nil {
				t.Fatalf("accepted invalid %s", kind)
			}
		}
	}
	if err := ValidateRules(ip, "geoip"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateRules(site, "geosite"); err != nil {
		t.Fatal(err)
	}
	invalid, _ := proto.Marshal(&router.GeoIPList{Entry: []*router.GeoIP{{CountryCode: "CN", Cidr: []*router.CIDR{{Ip: []byte{1, 2, 3, 4}, Prefix: 33}}}}})
	if ValidateRules(invalid, "geoip") == nil {
		t.Fatal("invalid CIDR accepted")
	}
}

func TestArchiveTargetAndCorruption(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	platform := "android"
	if runtime.GOOS == "darwin" {
		platform = "macos"
	}
	name := "xray"
	if runtime.GOOS == "windows" {
		platform = "windows"
		name = "xray.exe"
	}
	arch := "x64"
	wrong := "arm64"
	if runtime.GOARCH == "arm64" {
		arch, wrong = wrong, arch
	}
	file := filepath.Join(t.TempDir(), "component.zip")
	out, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(out)
	entry, err := writer.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = entry.Write(data); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	out.Close()
	if err = Validate(file, "xray", platform, arch); err != nil {
		t.Fatal(err)
	}
	if Validate(file, "xray", platform, wrong) == nil {
		t.Fatal("wrong target accepted")
	}
	if err = os.WriteFile(file, []byte("not an archive"), 0600); err != nil {
		t.Fatal(err)
	}
	if Validate(file, "xray", platform, arch) == nil {
		t.Fatal("corrupt archive accepted")
	}
}
