package database

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
)

type schemaQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}
type schemaShape map[string][]any

type legacySchemaContract struct {
	Format     int               `json:"format"`
	Migrations map[string]string `json:"migrations"`
	Shape      schemaShape       `json:"shape"`
}

// Capture actual PostgreSQL catalog state, not a hand-written ORM approximation.
// Column order is deliberately ignored; migration history baselines may originate
// from schema push, while names, types and integrity constraints must still match.
func readSchemaShape(ctx context.Context, q schemaQueryer, schema string) (schemaShape, error) {
	queries := map[string]string{
		"tables":      `SELECT to_jsonb(c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN('r','p') AND c.relname NOT IN('_prisma_migrations','_chordv_migrations') ORDER BY c.relname`,
		"columns":     `SELECT jsonb_build_array(c.relname,a.attname,t.typname,CASE WHEN tn.nspname=$1 THEN '@schema' ELSE tn.nspname END,a.atttypmod,a.attnotnull,coalesce(pg_get_expr(d.adbin,d.adrelid),''),a.attidentity,a.attgenerated,coalesce(coll.collname,'')) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace tn ON tn.oid=t.typnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation coll ON coll.oid=a.attcollation WHERE n.nspname=$1 AND c.relkind IN('r','p') AND c.relname NOT IN('_prisma_migrations','_chordv_migrations') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attname`,
		"constraints": `SELECT jsonb_build_array(c.relname,k.conname,k.contype,k.convalidated,pg_get_constraintdef(k.oid,true)) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname NOT IN('_prisma_migrations','_chordv_migrations') ORDER BY c.relname,k.conname`,
		"indexes":     `SELECT jsonb_build_array(c.relname,x.relname,i.indisunique,i.indisprimary,i.indisvalid,i.indisready,am.amname,(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid,k,true) ORDER BY k) FROM generate_series(1,i.indnatts) k),coalesce(pg_get_expr(i.indpred,i.indrelid),'')) FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_am am ON am.oid=x.relam JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname NOT IN('_prisma_migrations','_chordv_migrations') ORDER BY c.relname,x.relname`,
		"enums":       `SELECT jsonb_build_array(t.typname,jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname=$1 GROUP BY t.typname ORDER BY t.typname`,
	}
	result := schemaShape{}
	for kind, sql := range queries {
		rows, err := q.Query(ctx, sql, schema)
		if err != nil {
			return nil, fmt.Errorf("读取%s结构失败: %w", kind, err)
		}
		values := []any{}
		for rows.Next() {
			var raw []byte
			if err = rows.Scan(&raw); err != nil {
				rows.Close()
				return nil, err
			}
			var value any
			if err = json.Unmarshal(raw, &value); err != nil {
				rows.Close()
				return nil, err
			}
			values = append(values, value)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		result[kind] = values
	}
	return result, nil
}
