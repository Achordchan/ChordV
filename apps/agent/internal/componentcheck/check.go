// Package componentcheck validates downloaded assets without executing or extracting them.
package componentcheck

import (
	"archive/zip"
	"bytes"
	"debug/elf"
	"debug/macho"
	"debug/pe"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"regexp"

	"github.com/xtls/xray-core/app/router"
	"google.golang.org/protobuf/proto"
)

const maxBytes = 512 << 20

var label = regexp.MustCompile(`^[\x21-\x7e]{1,128}$`)

func Validate(file, kind, platform, arch string) error {
	info, err := os.Stat(file)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxBytes {
		return errors.New("invalid component size")
	}
	if kind == "xray" {
		return validateArchive(file, platform, arch)
	}
	if info.Size() > 64<<20 {
		return errors.New("ruleset exceeds 64 MiB validation limit")
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	return ValidateRules(data, kind)
}

// Use the same protobuf schemas as Xray; unknown-only or empty messages are not rulesets.
func ValidateRules(data []byte, kind string) error {
	entries := 0
	switch kind {
	case "geoip":
		list := &router.GeoIPList{}
		if err := proto.Unmarshal(data, list); err != nil {
			return err
		}
		for _, entry := range list.Entry {
			if !label.MatchString(entry.CountryCode) || len(entry.Cidr) == 0 {
				return errors.New("invalid GeoIP entry")
			}
			for _, cidr := range entry.Cidr {
				if (len(cidr.Ip) != 4 && len(cidr.Ip) != 16) || cidr.Prefix > uint32(len(cidr.Ip)*8) {
					return errors.New("invalid CIDR")
				}
			}
			entries++
		}
	case "geosite":
		list := &router.GeoSiteList{}
		if err := proto.Unmarshal(data, list); err != nil {
			return err
		}
		for _, entry := range list.Entry {
			if !label.MatchString(entry.CountryCode) || len(entry.Domain) == 0 {
				return errors.New("invalid GeoSite entry")
			}
			for _, domain := range entry.Domain {
				if domain.Value == "" || domain.Type < 0 || domain.Type > 3 {
					return errors.New("invalid domain")
				}
				if domain.Type == router.Domain_Regex {
					if _, err := regexp.Compile(domain.Value); err != nil {
						return err
					}
				}
			}
			entries++
		}
	default:
		return errors.New("unsupported ruleset kind")
	}
	if entries == 0 {
		return errors.New("empty ruleset")
	}
	return nil
}

func validateArchive(file, platform, arch string) error {
	if arch != "x64" && arch != "arm64" {
		return errors.New("unsupported architecture")
	}
	archive, err := zip.OpenReader(file)
	if err != nil {
		return err
	}
	defer archive.Close()
	wanted := "xray"
	if platform == "windows" {
		wanted = "xray.exe"
	}
	var executable []byte
	for _, entry := range archive.File {
		if path.Base(entry.Name) != wanted {
			continue
		}
		if executable != nil || !entry.Mode().IsRegular() || entry.UncompressedSize64 > maxBytes {
			return errors.New("invalid executable entry")
		}
		reader, err := entry.Open()
		if err != nil {
			return err
		}
		data, readErr := io.ReadAll(io.LimitReader(reader, maxBytes+1))
		reader.Close()
		if readErr != nil {
			return readErr
		}
		if len(data) > maxBytes {
			return errors.New("executable exceeds limit")
		}
		executable = data
	}
	if len(executable) == 0 {
		return errors.New("archive has no Xray executable")
	}
	switch platform {
	case "windows":
		f, err := pe.NewFile(bytes.NewReader(executable))
		if err != nil {
			return err
		}
		defer f.Close()
		machine := uint16(pe.IMAGE_FILE_MACHINE_AMD64)
		if arch == "arm64" {
			machine = pe.IMAGE_FILE_MACHINE_ARM64
		}
		if f.Machine == machine && f.Characteristics&pe.IMAGE_FILE_EXECUTABLE_IMAGE != 0 {
			return nil
		}
	case "macos":
		f, err := macho.NewFile(bytes.NewReader(executable))
		if err != nil {
			return err
		}
		defer f.Close()
		cpu := macho.CpuAmd64
		if arch == "arm64" {
			cpu = macho.CpuArm64
		}
		if f.Cpu == cpu && f.Type == macho.TypeExec {
			return nil
		}
	case "android":
		f, err := elf.NewFile(bytes.NewReader(executable))
		if err != nil {
			return err
		}
		defer f.Close()
		machine := elf.EM_X86_64
		if arch == "arm64" {
			machine = elf.EM_AARCH64
		}
		if f.Machine == machine && (f.Type == elf.ET_EXEC || f.Type == elf.ET_DYN) {
			return nil
		}
	default:
		return errors.New("unsupported executable platform")
	}
	return fmt.Errorf("executable does not match %s/%s", platform, arch)
}
