package releaseprotocol

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

type TagBinding struct {
	Mode       string `json:"mode"`
	Repository string `json:"repository,omitempty"`
}
type Observation struct {
	Commit string
	Tree   string
}
type Read func(context.Context, string, int64) ([]byte, error)

var objectPattern = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)
var repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$`)

func CanonicalRepository(value string) (string, error) {
	if !repositoryPattern.MatchString(value) {
		return "", errors.New("发布仓库格式无效")
	}
	for _, part := range strings.Split(value, "/") {
		if part == "." || part == ".." {
			return "", errors.New("发布仓库格式无效")
		}
	}
	return strings.ToLower(value), nil
}
func Validate(schema int, binding *TagBinding, source, repository string, hasKey bool) (bool, error) {
	if schema == 1 {
		if binding == nil || binding.Mode == "source-commit" {
			return false, nil
		}
		return false, errors.New("schema1不能声明新发布绑定模式")
	}
	if schema != 2 || binding == nil || binding.Mode != "signed-manifest-tree" {
		return false, errors.New("发布schema与绑定模式不匹配")
	}
	canonical, err := CanonicalRepository(repository)
	if err != nil || binding.Repository != canonical || !objectPattern.MatchString(source) {
		return false, errors.New("已签仓库或源码绑定无效")
	}
	if !hasKey {
		return false, errors.New("新发布绑定必须配置固定验签公钥")
	}
	return true, nil
}

// Verify checks Git content against bytes already authenticated by the caller's pinned key and Validate.
func Verify(ctx context.Context, read Read, repository, tag, name string, body, signature []byte) (Observation, error) {
	canonical, err := CanonicalRepository(repository)
	if err != nil {
		return Observation{}, err
	}
	if len(body) == 0 || len(body) > 1<<20 || len(signature) == 0 || len(signature) > 1024 {
		return Observation{}, errors.New("发布绑定原文大小无效")
	}
	prefix := "/repos/" + canonical + "/git/"
	load := func(path string, value any) error {
		raw, err := read(ctx, path, 64<<10)
		if err != nil {
			return err
		}
		if json.Unmarshal(raw, value) != nil {
			return errors.New("Git发布对象JSON无效")
		}
		return nil
	}
	type object struct {
		SHA  string `json:"sha"`
		Type string `json:"type"`
	}
	var ref struct {
		Object object `json:"object"`
	}
	if err = load(prefix+"ref/tags/"+url.PathEscape(tag), &ref); err != nil {
		return Observation{}, err
	}
	current := ref.Object
	seen := map[string]bool{}
	for current.Type == "tag" {
		if !objectPattern.MatchString(current.SHA) || seen[current.SHA] || len(seen) >= 10 {
			return Observation{}, errors.New("Git标签引用循环或身份无效")
		}
		seen[current.SHA] = true
		var annotated struct {
			SHA    string `json:"sha"`
			Object object `json:"object"`
		}
		if err = load(prefix+"tags/"+current.SHA, &annotated); err != nil {
			return Observation{}, err
		}
		if annotated.SHA != current.SHA {
			return Observation{}, errors.New("Git标签对象身份不符")
		}
		current = annotated.Object
	}
	if current.Type != "commit" || !objectPattern.MatchString(current.SHA) {
		return Observation{}, errors.New("Git发布标签不是有效commit")
	}
	var commit struct {
		SHA  string `json:"sha"`
		Tree struct {
			SHA string `json:"sha"`
		} `json:"tree"`
		Parents []json.RawMessage `json:"parents"`
	}
	if err = load(prefix+"commits/"+current.SHA, &commit); err != nil {
		return Observation{}, err
	}
	if commit.SHA != current.SHA || !objectPattern.MatchString(commit.Tree.SHA) || commit.Parents == nil || len(commit.Parents) != 0 {
		return Observation{}, errors.New("元数据commit必须零父提交且对象身份正确")
	}
	var tree struct {
		SHA       string `json:"sha"`
		Truncated *bool  `json:"truncated"`
		Entries   []struct {
			Path string `json:"path"`
			Mode string `json:"mode"`
			Type string `json:"type"`
			SHA  string `json:"sha"`
		} `json:"tree"`
	}
	if err = load(prefix+"trees/"+commit.Tree.SHA, &tree); err != nil {
		return Observation{}, err
	}
	if tree.SHA != commit.Tree.SHA || tree.Truncated == nil || *tree.Truncated || len(tree.Entries) != 2 {
		return Observation{}, errors.New("元数据树必须完整且只有两个普通文件")
	}
	expected := map[string][]byte{name: body, name + ".sig": signature}
	seenPaths := map[string]bool{}
	for _, entry := range tree.Entries {
		wanted, ok := expected[entry.Path]
		if !ok || seenPaths[entry.Path] || entry.Mode != "100644" || entry.Type != "blob" || !objectPattern.MatchString(entry.SHA) {
			return Observation{}, errors.New("元数据树包含额外、重复或非普通文件")
		}
		seenPaths[entry.Path] = true
		raw, err := read(ctx, prefix+"blobs/"+entry.SHA, 2<<20)
		if err != nil {
			return Observation{}, err
		}
		var blob struct {
			SHA      string `json:"sha"`
			Encoding string `json:"encoding"`
			Size     int    `json:"size"`
			Content  string `json:"content"`
		}
		if json.Unmarshal(raw, &blob) != nil || blob.SHA != entry.SHA || blob.Encoding != "base64" || blob.Size != len(wanted) {
			return Observation{}, errors.New("元数据blob身份或长度不符")
		}
		decoded, err := base64.StdEncoding.DecodeString(blob.Content)
		if err != nil || string(decoded) != string(wanted) || gitBlobID(decoded, len(entry.SHA)) != entry.SHA {
			return Observation{}, errors.New("元数据manifest或raw.sig原文不一致")
		}
	}
	return Observation{Commit: current.SHA, Tree: commit.Tree.SHA}, nil
}
func gitBlobID(data []byte, length int) string {
	bytes := append([]byte(fmt.Sprintf("blob %d\x00", len(data))), data...)
	if length == 40 {
		sum := sha1.Sum(bytes)
		return hex.EncodeToString(sum[:])
	}
	sum := sha256.Sum256(bytes)
	return hex.EncodeToString(sum[:])
}
