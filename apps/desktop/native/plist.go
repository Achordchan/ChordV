package main

import (
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

type plistDate string

func parsePlist(data []byte) (map[string]any, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	for {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		if start, ok := token.(xml.StartElement); ok && start.Name.Local == "dict" {
			value, err := readPlistValue(decoder, start)
			if err != nil {
				return nil, err
			}
			dictionary, ok := value.(map[string]any)
			if !ok {
				return nil, errors.New("代理配置不是字典")
			}
			return dictionary, nil
		}
	}
}
func nextPlistStart(decoder *xml.Decoder) (xml.StartElement, bool, error) {
	for {
		token, err := decoder.Token()
		if err != nil {
			return xml.StartElement{}, false, err
		}
		switch value := token.(type) {
		case xml.StartElement:
			return value, true, nil
		case xml.EndElement:
			return xml.StartElement{}, false, nil
		}
	}
}
func readPlistValue(decoder *xml.Decoder, start xml.StartElement) (any, error) {
	switch start.Name.Local {
	case "dict":
		result := map[string]any{}
		for {
			keyStart, exists, err := nextPlistStart(decoder)
			if err != nil {
				return nil, err
			}
			if !exists {
				return result, nil
			}
			if keyStart.Name.Local != "key" {
				return nil, errors.New("代理字典字段无效")
			}
			var key string
			if err = decoder.DecodeElement(&key, &keyStart); err != nil {
				return nil, err
			}
			valueStart, exists, err := nextPlistStart(decoder)
			if err != nil || !exists {
				return nil, errors.New("代理字典字段缺少值")
			}
			value, err := readPlistValue(decoder, valueStart)
			if err != nil {
				return nil, err
			}
			result[key] = value
		}
	case "array":
		result := []any{}
		for {
			child, exists, err := nextPlistStart(decoder)
			if err != nil {
				return nil, err
			}
			if !exists {
				return result, nil
			}
			value, err := readPlistValue(decoder, child)
			if err != nil {
				return nil, err
			}
			result = append(result, value)
		}
	default:
		var text string
		if err := decoder.DecodeElement(&text, &start); err != nil {
			return nil, err
		}
		switch start.Name.Local {
		case "string":
			return text, nil
		case "integer":
			return strconv.ParseInt(strings.TrimSpace(text), 10, 64)
		case "real":
			return strconv.ParseFloat(strings.TrimSpace(text), 64)
		case "true":
			return true, nil
		case "false":
			return false, nil
		case "data":
			return base64.StdEncoding.DecodeString(strings.Join(strings.Fields(text), ""))
		case "date":
			return plistDate(text), nil
		default:
			return nil, errors.New("代理配置包含无法保留的数据类型")
		}
	}
}
func marshalPlist(dictionary map[string]any) ([]byte, error) {
	var buffer bytes.Buffer
	buffer.WriteString(xml.Header + `<plist version="1.0">`)
	if err := writePlistValue(&buffer, dictionary); err != nil {
		return nil, err
	}
	buffer.WriteString("</plist>")
	return buffer.Bytes(), nil
}
func writePlistValue(writer io.Writer, value any) error {
	text := func(tag, value string) error {
		fmt.Fprint(writer, "<"+tag+">")
		if err := xml.EscapeText(writer, []byte(value)); err != nil {
			return err
		}
		_, err := fmt.Fprint(writer, "</"+tag+">")
		return err
	}
	switch value := value.(type) {
	case map[string]any:
		fmt.Fprint(writer, "<dict>")
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if err := text("key", key); err != nil {
				return err
			}
			if err := writePlistValue(writer, value[key]); err != nil {
				return err
			}
		}
		fmt.Fprint(writer, "</dict>")
	case []any:
		fmt.Fprint(writer, "<array>")
		for _, item := range value {
			if err := writePlistValue(writer, item); err != nil {
				return err
			}
		}
		fmt.Fprint(writer, "</array>")
	case string:
		return text("string", value)
	case int64:
		return text("integer", strconv.FormatInt(value, 10))
	case float64:
		return text("real", strconv.FormatFloat(value, 'g', -1, 64))
	case bool:
		if value {
			fmt.Fprint(writer, "<true/>")
		} else {
			fmt.Fprint(writer, "<false/>")
		}
	case []byte:
		return text("data", base64.StdEncoding.EncodeToString(value))
	case plistDate:
		return text("date", string(value))
	default:
		return errors.New("代理配置包含无法序列化的数据类型")
	}
	return nil
}
