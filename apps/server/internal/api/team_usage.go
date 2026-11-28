package api

import "context"

// Positive byte counters are authoritative; default-zero legacy rows retain
// their GB history. Aggregate before converting back to the public GB DTO.
const ledgerTrafficBytesSQL = `CASE WHEN l."usedTrafficBytes">0 THEN l."usedTrafficBytes"::numeric
       ELSE l."usedTrafficGb"::numeric*1073741824 END`

const teamUsageSQL = `WITH grouped AS (
 SELECT l."teamId",l."userId",l."subscriptionId",l."nodeId",
   sum(` + ledgerTrafficBytesSQL + `) AS bytes,
   count(*) AS records,max(l."recordedAt") AS recorded
 FROM "TrafficLedger" l WHERE l."teamId"=ANY($1::text[])
 GROUP BY l."teamId",l."userId",l."subscriptionId",l."nodeId"
), members AS (
 SELECT "teamId","userId",sum(bytes) AS bytes,sum(records) AS records,max(recorded) AS recorded,
   (array_agg("subscriptionId" ORDER BY recorded DESC,"subscriptionId","nodeId" NULLS LAST))[1] AS subscription,
   (array_agg("nodeId" ORDER BY recorded DESC,"subscriptionId","nodeId" NULLS LAST))[1] AS latest_node
 FROM grouped GROUP BY "teamId","userId"
), nodes AS (
 SELECT "teamId","userId","nodeId",sum(bytes) AS bytes,sum(records) AS records,max(recorded) AS recorded
 FROM grouped GROUP BY "teamId","userId","nodeId"
)
SELECT jsonb_build_object(
 'id','ledger_summary_'||m."teamId"||'_'||m."userId"||'_'||coalesce(m.latest_node,'unknown'),
 'teamId',m."teamId",'userId',m."userId",'userDisplayName',u."displayName",'userEmail',u.email,
 'subscriptionId',m.subscription,'usedTrafficGb',round(m.bytes/1073741824,3),
 'memberTotalUsedTrafficGb',round(m.bytes/1073741824,3),'recordedAt',m.recorded,'recordCount',m.records,
 'nodeBreakdown',coalesce((SELECT jsonb_agg(jsonb_build_object(
   'nodeId',coalesce(g."nodeId",'unknown'),'nodeName',coalesce(n.name,'未知节点'),'nodeRegion',coalesce(n.region,'未知'),
   'usedTrafficGb',g.bytes/1073741824,'recordCount',g.records,'lastRecordedAt',g.recorded
 ) ORDER BY g.recorded DESC,g."nodeId" NULLS LAST)
 FROM nodes g LEFT JOIN "Node" n ON n.id=g."nodeId"
 WHERE g."teamId"=m."teamId" AND g."userId"=m."userId"),'[]'::jsonb))
FROM members m JOIN "User" u ON u.id=m."userId"
ORDER BY m.recorded DESC,m."userId"`

func loadTeamUsage(ctx context.Context, q queryer, teamIDs []string) (map[string][]Object, error) {
	result := make(map[string][]Object, len(teamIDs))
	for _, id := range teamIDs {
		result[id] = []Object{}
	}
	if len(teamIDs) == 0 {
		return result, nil
	}
	rows, err := list(ctx, q, teamUsageSQL, teamIDs)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		id := text(row, "teamId")
		result[id] = append(result[id], row)
	}
	return result, nil
}

func attachTeamUsage(ctx context.Context, q queryer, teams []Object) error {
	ids := make([]string, 0, len(teams))
	for _, team := range teams {
		ids = append(ids, text(team, "id"))
	}
	usage, err := loadTeamUsage(ctx, q, ids)
	if err != nil {
		return err
	}
	for _, team := range teams {
		entries := usage[text(team, "id")]
		team["usage"] = entries
		byUser := map[string]float64{}
		for _, item := range entries {
			byUser[text(item, "userId")] = number(item, "memberTotalUsedTrafficGb")
		}
		members, _ := team["members"].([]any)
		for _, raw := range members {
			if member, ok := raw.(map[string]any); ok {
				member["usedTrafficGb"] = byUser[text(member, "userId")]
			}
		}
	}
	return nil
}
