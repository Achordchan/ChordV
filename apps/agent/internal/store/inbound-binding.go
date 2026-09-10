package store

import "fmt"

func (s *Store) InboundBinding() (string, error) { return s.meta("inbound_binding") }

// Binding is immutable for a node identity. The runner serializes this write
// with command completion, sampling, and all other state mutations.
func (s *Store) SaveInboundBinding(tag string) error {
	current, err := s.InboundBinding()
	if err != nil {
		return err
	}
	if tag == "" || (current != "" && current != tag) {
		return fmt.Errorf("禁止覆盖已有入站绑定")
	}
	return s.setMeta("inbound_binding", tag)
}
