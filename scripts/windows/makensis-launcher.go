//go:build ignore

// A host-native launcher is needed because Go's Windows exec path cannot
// execute a Node shebang or .cmd file as the makensis compiler directly.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	configFile := filepath.Join(filepath.Dir(self), "launcher.json")
	data, err := os.ReadFile(configFile)
	if err != nil {
		return err
	}
	var config struct{ Node, Script string }
	if err := json.Unmarshal(data, &config); err != nil {
		return err
	}
	if !filepath.IsAbs(config.Node) || !filepath.IsAbs(config.Script) {
		return fmt.Errorf("makensis launcher requires absolute Node and script paths")
	}
	args := append([]string{config.Script, configFile}, os.Args[1:]...)
	cmd := exec.Command(config.Node, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		if exited, ok := err.(*exec.ExitError); ok {
			os.Exit(exited.ExitCode())
		}
		return err
	}
	return nil
}
