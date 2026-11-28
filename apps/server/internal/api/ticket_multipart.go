package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
)

// 合并上传的部分成功是旧工单契约：有效文字必须真正保存后才能返回附件失败标记。
func (s *Server) saveMultipartTicketReply(w http.ResponseWriter, r *http.Request, user Object, content string, uploaded Object, uploadError error) (any, error) {
	status := "none"
	notice := ""
	var failure any
	if uploadError != nil {
		status = "failed"
		failure = uploadError.Error()
		notice = "\n\n附件上传失败，文字回复已保存。请检查图床配置或稍后重试。"
	} else if uploaded != nil {
		status = "uploaded"
		if content == "" {
			content = "上传了附件：" + text(uploaded, "fileName")
		}
	}
	input := Object{"body": content}
	if uploaded != nil {
		input["attachment"] = uploaded
	}
	payload, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	r.Body = io.NopCloser(bytes.NewReader(payload))
	detail, err := s.writeTicketReply(w, r, user, notice)
	if err != nil {
		return nil, err
	}
	result := detail.(Object)
	result["attachmentUploadStatus"] = status
	result["attachmentUploadError"] = failure
	return result, nil
}
