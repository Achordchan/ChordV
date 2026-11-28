package api

import (
	"context"
	"fmt"
	"strconv"
)

func (s *Server) recordClientVersion(ctx context.Context, user, input Object) error {
	if err := enum(input, "platform", "macos", "windows", "android", "ios"); err != nil {
		return err
	}
	if err := requireText(input, "platform", "version"); err != nil {
		return err
	}
	if _, err := parseVersion(text(input, "version")); err != nil {
		return err
	}
	channel := text(input, "channel")
	if channel == "" {
		channel = "stable"
	}
	if channel != "stable" && channel != "beta" {
		return fail(400, "版本上报渠道无效")
	}
	var build any
	if value, ok := input["build"]; ok && value != nil && fmt.Sprint(value) != "" {
		parsed, err := strconv.ParseInt(fmt.Sprint(value), 10, 32)
		if err != nil || parsed < 1 || parsed > 999999999 {
			return fail(400, "客户端构建号需在1至999999999之间")
		}
		build = parsed
	}
	_, err := s.DB.Exec(ctx, `INSERT INTO "UserClientVersion"("userId",platform,version,build,channel,"lastSeenAt","updatedAt") VALUES($1,$2::"ReleasePlatform",$3,$4,$5::"ReleaseChannel",now(),now()) ON CONFLICT("userId",platform) DO UPDATE SET version=EXCLUDED.version,build=EXCLUDED.build,channel=EXCLUDED.channel,"lastSeenAt"=now(),"updatedAt"=now() WHERE "UserClientVersion".version IS DISTINCT FROM EXCLUDED.version OR "UserClientVersion".build IS DISTINCT FROM EXCLUDED.build OR "UserClientVersion".channel IS DISTINCT FROM EXCLUDED.channel OR "UserClientVersion"."lastSeenAt"<now()-interval '10 minutes'`, user["id"], input["platform"], input["version"], build, channel)
	return err
}
