package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
)

const attachmentMaxBytes = 10 * 1024 * 1024

func (s *Server) imageConfig(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	cfg, err := s.setting(r.Context(), "image-bed")
	if err != nil {
		return nil, err
	}
	token := text(cfg, "apiToken")
	var preview any
	if token != "" {
		preview = "已设置"
	}
	source := "none"
	if token != "" {
		source = "database"
	}
	return Object{"baseUrl": text(cfg, "baseUrl"), "uploadFolder": cfg["uploadFolder"], "uploadChannel": cfg["uploadChannel"], "channelName": cfg["channelName"], "hasToken": token != "", "tokenPreview": preview, "tokenSource": source, "updatedAt": cfg["updatedAt"]}, nil
}
func (s *Server) saveImageConfig(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	cfg, err := s.setting(r.Context(), "image-bed")
	if err != nil {
		return nil, err
	}
	for key, value := range pick(input, "baseUrl", "apiToken", "uploadFolder", "uploadChannel", "channelName") {
		cfg[key] = value
	}
	if text(cfg, "baseUrl") != "" {
		origin, err := s.integrationOrigin(text(cfg, "baseUrl"))
		if err != nil {
			return nil, err
		}
		cfg["baseUrl"] = origin
	}
	for _, key := range []string{"apiToken", "uploadChannel", "channelName"} {
		if strings.ContainsAny(text(cfg, key), "\r\n") {
			return nil, fail(400, "配置字段包含无效换行")
		}
	}
	if folder := text(cfg, "uploadFolder"); folder != "" {
		if _, err = imagePath(folder); err != nil {
			return nil, err
		}
	}
	cfg["updatedAt"] = now()
	if err = s.saveSetting(r.Context(), "image-bed", cfg); err != nil {
		return nil, err
	}
	s.changed("imageBed", "")
	return s.imageConfig(w, r, user)
}
func imagePath(value string) (string, error) {
	if u, err := url.Parse(value); err == nil && u.IsAbs() {
		value = u.Path
	}
	value = strings.TrimPrefix(strings.TrimLeft(value, "/"), "file/")
	if value == "" || strings.Contains(value, "..") || strings.ContainsAny(value, "\\\x00\r\n") {
		return "", fail(400, "图床文件路径无效")
	}
	parts := strings.Split(value, "/")
	for i, part := range parts {
		if part == "" {
			return "", fail(400, "图床文件路径无效")
		}
		parts[i] = url.PathEscape(part)
	}
	return strings.Join(parts, "/"), nil
}
func (s *Server) imageRequest(ctx context.Context, cfg Object, route string, contentType string, payload io.Reader, allowMissing ...bool) (any, error) {
	base, err := s.integrationOrigin(text(cfg, "baseUrl"))
	if err != nil {
		return nil, err
	}
	if text(cfg, "apiToken") == "" {
		return nil, fail(400, "图床 API Token 未配置")
	}
	method := "GET"
	if payload != nil {
		method = "POST"
	}
	request, err := http.NewRequestWithContext(ctx, method, base+route, payload)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+text(cfg, "apiToken"))
	request.Header.Set("Accept", "application/json")
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	client := *s.HTTP
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return fail(502, "图床请求不允许重定向") }
	response, err := client.Do(request)
	if err != nil {
		return nil, fail(502, "本地图床连接失败")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
	if err != nil || len(raw) > 1<<20 {
		return nil, fail(502, "图床响应超出限制")
	}
	if response.StatusCode == 404 && len(allowMissing) > 0 && allowMissing[0] {
		return Object{"success": true}, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fail(502, "图床返回 HTTP "+strconv.Itoa(response.StatusCode))
	}
	var result any
	if err = json.Unmarshal(raw, &result); err != nil {
		return nil, fail(502, "图床响应格式无效")
	}
	return result, nil
}
func (s *Server) imageFiles(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	cfg, err := s.setting(r.Context(), "image-bed")
	if err != nil {
		return nil, err
	}
	if r.Method == "DELETE" {
		relative, err := imagePath(r.URL.Query().Get("path"))
		if err != nil {
			return nil, err
		}
		query := ""
		if r.URL.Query().Get("folder") == "true" {
			query = "?folder=true"
		}
		raw, err := s.imageRequest(r.Context(), cfg, "/api/manage/delete/"+relative+query, "", nil)
		if err != nil {
			return nil, err
		}
		record, ok := raw.(map[string]any)
		if !ok {
			return nil, fail(502, "图床删除响应格式无效")
		}
		s.changed("imageBed", "")
		fileID, _ := url.PathUnescape(relative)
		return imageBedDeleteDTO(record, fileID, text(cfg, "apiToken")), nil
	}
	params := url.Values{}
	start, _ := strconv.Atoi(r.URL.Query().Get("start"))
	count, _ := strconv.Atoi(r.URL.Query().Get("count"))
	if start < 0 || start > 10000 {
		return nil, fail(400, "列表起始位置无效")
	}
	if count < 1 || count > 100 {
		count = 50
	}
	params.Set("start", strconv.Itoa(start))
	params.Set("count", strconv.Itoa(count))
	params.Set("fileType", "image")
	for _, key := range []string{"search", "dir", "recursive"} {
		if value := r.URL.Query().Get(key); value != "" {
			params.Set(key, value)
		}
	}
	if params.Get("dir") == "" && text(cfg, "uploadFolder") != "" {
		params.Set("dir", text(cfg, "uploadFolder"))
	}
	raw, err := s.imageRequest(r.Context(), cfg, "/api/manage/list?"+params.Encode(), "", nil)
	if err != nil {
		return nil, err
	}
	record, ok := raw.(map[string]any)
	if !ok {
		return nil, fail(502, "图床列表响应格式无效")
	}
	if record["success"] == false {
		detail := sanitizeImageBedError(imageBedText(record, "message", "error"), text(cfg, "apiToken"))
		if detail == "" {
			detail = "图床未提供错误详情"
		}
		return nil, fail(502, "图床列表读取失败："+detail)
	}
	return imageBedListDTO(record, text(cfg, "baseUrl")), nil
}
func readTicketImage(file multipart.File) ([]byte, string, error) {
	data, err := io.ReadAll(io.LimitReader(file, attachmentMaxBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) == 0 || len(data) > attachmentMaxBytes {
		return nil, "", fail(400, "图片附件不能为空且不能超过10MiB")
	}
	mime := http.DetectContentType(data)
	if !strings.HasPrefix(mime, "image/") {
		return nil, "", fail(400, "附件必须是有效图片")
	}
	return data, mime, nil
}
func (s *Server) uploadValidatedTicketImage(ctx context.Context, data []byte, mime, filename string, configured ...Object) (Object, error) {
	var cfg Object
	if len(configured) > 0 {
		cfg = configured[0]
	} else {
		var err error
		cfg, err = s.setting(ctx, "image-bed")
		if err != nil {
			return nil, err
		}
	}
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	part, err := writer.CreateFormFile("file", path.Base(strings.ReplaceAll(filename, "\\", "/")))
	if err != nil {
		return nil, err
	}
	if _, err = part.Write(data); err != nil {
		return nil, err
	}
	if err = writer.Close(); err != nil {
		return nil, err
	}
	query := url.Values{"returnFormat": []string{"full"}}
	for _, key := range []string{"uploadFolder", "uploadChannel", "channelName"} {
		if text(cfg, key) != "" {
			query.Set(key, text(cfg, key))
		}
	}
	raw, err := s.imageRequest(ctx, cfg, "/upload?"+query.Encode(), writer.FormDataContentType(), &buffer)
	if err != nil {
		return nil, err
	}
	if values, ok := raw.([]any); ok && len(values) > 0 {
		raw = values[0]
	}
	result, ok := raw.(map[string]any)
	if !ok || result["success"] == false {
		return nil, fail(502, "图床上传响应无效")
	}
	address := text(result, "url")
	if address == "" {
		address = text(result, "fileUrl")
	}
	if address == "" {
		address = text(result, "src")
	}
	base, _ := url.Parse(text(cfg, "baseUrl"))
	relative, err := url.Parse(address)
	if err != nil || address == "" {
		return nil, fail(502, "图床响应缺少文件地址")
	}
	resolved := base.ResolveReference(relative)
	if resolved.Host != base.Host || resolved.Scheme != base.Scheme {
		return nil, fail(502, "本地图床返回了其他站点地址")
	}
	return Object{"url": resolved.String(), "providerFileId": strings.TrimPrefix(resolved.Path, "/file/"), "fileName": path.Base(strings.ReplaceAll(filename, "\\", "/")), "mimeType": mime, "fileSizeBytes": strconv.Itoa(len(data))}, nil
}
func (s *Server) uploadLimits(_ http.ResponseWriter, _ *http.Request, _ Object) (any, error) {
	return Object{"releaseArtifactMaxBytes": 1073741824, "runtimeComponentMaxBytes": 268435456, "supportTicketAttachmentMaxBytes": attachmentMaxBytes}, nil
}
