package main

import (
	"encoding/base64"
	"errors"
)

func macProxyFlag(value any) bool {
	switch value := value.(type) {
	case bool:
		return value
	case int64:
		return value != 0
	}
	return false
}

func macOwnedProxy(before proxySetting, httpPort, socksPort int) (proxySetting, error) {
	data, err := base64.StdEncoding.DecodeString(before.Values["configuration"])
	if err != nil {
		return proxySetting{}, errors.New("系统代理原始快照损坏")
	}
	dictionary, err := parsePlist(data)
	if err != nil {
		return proxySetting{}, err
	}
	for _, prefix := range []string{"HTTP", "HTTPS", "SOCKS"} {
		port := httpPort
		if prefix == "SOCKS" {
			port = socksPort
		}
		dictionary[prefix+"Enable"] = int64(1)
		dictionary[prefix+"Proxy"] = "127.0.0.1"
		dictionary[prefix+"Port"] = int64(port)
		delete(dictionary, prefix+"User")
	}
	dictionary["ProxyAutoConfigEnable"] = int64(0)
	dictionary["ProxyAutoDiscoveryEnable"] = int64(0)
	bytes, err := marshalPlist(dictionary)
	if err != nil {
		return proxySetting{}, err
	}
	return proxySetting{Service: before.Service, Kind: "macos", Values: map[string]string{"name": before.Values["name"], "configuration": base64.StdEncoding.EncodeToString(bytes), "missing": "0", "enabled": "Yes"}}, nil
}
