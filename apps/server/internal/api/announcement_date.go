package api

import (
	"regexp"
	"strconv"
	"time"
)

var announcementCalendar = regexp.MustCompile(`^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?)?$`)
var announcementLegacyMonth = regexp.MustCompile(`^(\d{4})-0(0[1-9]|1[0-2])$`)

// Date-only inputs use UTC; a datetime without a zone uses the server's local
// wall clock, as JS Date did. ISO week forms JS Date could not store fail
// before SQL instead of surfacing the former service's HTTP503.
func announcementDate(raw any) (string, error) {
	value, valid := raw.(string)
	if !valid {
		return "", fail(400, "publishedAt 必须是有效 ISO 日期字符串")
	}
	if legacy := announcementLegacyMonth.FindStringSubmatch(value); legacy != nil {
		value = legacy[1] + "-" + legacy[2]
	}
	parts := announcementCalendar.FindStringSubmatch(value)
	if parts == nil {
		return "", fail(400, "publishedAt 必须是有效 ISO 日期字符串")
	}
	read := func(index, fallback int) int {
		if parts[index] == "" {
			return fallback
		}
		n, _ := strconv.Atoi(parts[index])
		return n
	}
	year, month, day := read(1, 0), read(2, 1), read(3, 1)
	hour, minute, second := read(4, 0), read(5, 0), read(6, 0)
	millisecond := 0
	if parts[7] != "" {
		millisecond, _ = strconv.Atoi((parts[7] + "000")[:3])
	}
	if month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59 || second > 59 || hour == 24 && (minute != 0 || second != 0 || millisecond != 0) || parts[4] != "" && (parts[2] == "" || parts[3] == "") {
		return "", fail(400, "publishedAt 必须是有效 ISO 日期字符串")
	}
	offsetHour, offsetMinute := read(10, 0), read(11, 0)
	if offsetHour > 23 || offsetMinute > 59 {
		return "", fail(400, "publishedAt 时区无效")
	}
	offset := (offsetHour*60 + offsetMinute) * 60
	if parts[9] == "-" {
		offset = -offset
	}
	date := time.Date(year, time.Month(month), day, hour, minute, second, millisecond*int(time.Millisecond), time.FixedZone("", offset)).UTC()
	if parts[4] != "" && parts[8] == "" && parts[9] == "" {
		wall := time.Date(year, time.Month(month), day, hour, minute, second, millisecond*int(time.Millisecond), time.UTC)
		var err error
		date, err = announcementLocalCalendar(wall, time.Local)
		if err != nil {
			return "", err
		}
	}
	if date.Year() < 1 || date.Year() > 9999 {
		return "", fail(400, "publishedAt 超出数据库日期范围")
	}
	return date.Format(time.RFC3339Nano), nil
}

func announcementLocalCalendar(wall time.Time, location *time.Location) (time.Time, error) {
	seed := time.Date(wall.Year(), wall.Month(), wall.Day(), wall.Hour(), wall.Minute(), wall.Second(), wall.Nanosecond(), location)
	start, end := seed.ZoneBounds()
	points := []time.Time{seed}
	if !start.IsZero() {
		points = append(points, start.Add(-time.Nanosecond))
	}
	if !end.IsZero() {
		points = append(points, end)
	}
	offsets := map[int]bool{}
	for _, point := range points {
		_, offset := point.In(location).Zone()
		offsets[offset] = true
	}
	var earliest time.Time
	found := false
	for offset := range offsets {
		candidate := wall.Add(-time.Duration(offset) * time.Second)
		local := candidate.In(location)
		localWall := time.Date(local.Year(), local.Month(), local.Day(), local.Hour(), local.Minute(), local.Second(), local.Nanosecond(), time.UTC)
		if localWall.Equal(wall) && (!found || candidate.Before(earliest)) {
			earliest, found = candidate, true
		}
	}
	if found {
		// JS Date's compatible disambiguation chooses the earlier overlap.
		return earliest, nil
	}
	for _, boundary := range []time.Time{start, end} {
		if boundary.IsZero() {
			continue
		}
		_, before := boundary.Add(-time.Nanosecond).In(location).Zone()
		_, after := boundary.In(location).Zone()
		if after <= before {
			continue
		}
		gapStart := boundary.UTC().Add(time.Duration(before) * time.Second)
		gapEnd := boundary.UTC().Add(time.Duration(after) * time.Second)
		if !wall.Before(gapStart) && wall.Before(gapEnd) {
			// Interpreting a missing wall time with the pre-transition offset
			// advances it by the actual gap, including half-hour transitions.
			return wall.Add(-time.Duration(before) * time.Second), nil
		}
	}
	return time.Time{}, fail(400, "publishedAt 无法按当前时区解析")
}
