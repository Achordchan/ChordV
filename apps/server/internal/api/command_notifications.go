package api

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const commandNotificationChannel = "chordv_go_agent_commands"
const commandNotificationChannelSQL = `CASE WHEN current_schema()='public' THEN '` + commandNotificationChannel + `' ELSE '` + commandNotificationChannel + `_'||md5(current_schema()::text) END`

func notifyCommands(ctx context.Context, q queryer, nodeID string) error {
	_, err := q.Exec(ctx, `SELECT pg_notify(`+commandNotificationChannelSQL+`,$1)`, nodeID)
	return err
}

func listenCommandNotifications(ctx context.Context, connection *pgxpool.Conn) error {
	var channel string
	if err := connection.QueryRow(ctx, `SELECT `+commandNotificationChannelSQL).Scan(&channel); err != nil {
		return err
	}
	_, err := connection.Exec(ctx, `LISTEN `+pgx.Identifier{channel}.Sanitize())
	return err
}

func (s *Server) startCommandNotifications(ctx context.Context) error {
	connection, err := s.DB.Acquire(ctx)
	if err != nil {
		return err
	}
	if err = listenCommandNotifications(ctx, connection); err != nil {
		connection.Release()
		return err
	}
	s.listenerWG.Add(1)
	go s.commandNotificationLoop(connection)
	return nil
}
func (s *Server) commandNotificationLoop(connection *pgxpool.Conn) {
	defer s.listenerWG.Done()
	defer func() {
		if connection != nil {
			connection.Release()
		}
	}()
	backoff := time.Second
	for {
		notification, err := connection.Conn().WaitForNotification(s.resyncContext)
		if err == nil {
			backoff = time.Second
			if notification.Payload != "" {
				s.events.publish("agent:"+notification.Payload, Object{"type": "command_ready"})
			}
			continue
		}
		connection.Release()
		connection = nil
		for {
			timer := time.NewTimer(backoff)
			select {
			case <-s.resyncStop:
				timer.Stop()
				return
			case <-timer.C:
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
			var acquireErr error
			connection, acquireErr = s.DB.Acquire(s.resyncContext)
			if acquireErr != nil {
				if s.resyncContext.Err() != nil {
					return
				}
				continue
			}
			if acquireErr = listenCommandNotifications(s.resyncContext, connection); acquireErr != nil {
				connection.Release()
				connection = nil
				continue
			}
			// LISTEN precedes this durable catch-up: commits during a disconnect
			// cannot leave already-connected Agent streams asleep indefinitely.
			jobs, e := list(s.resyncContext, s.DB, `SELECT jsonb_build_object('id',id,'nodeId',"nodeId",'at',"nextRunAt") FROM "NodeCommandJob" WHERE status IN('pending','running','failed') ORDER BY "nextRunAt"`)
			if e != nil {
				connection.Release()
				connection = nil
				continue
			}
			for _, job := range jobs {
				at, e := parseTimestamp(text(job, "at"))
				if e == nil {
					s.scheduleEntity("command", text(job, "id"), at)
				}
				s.events.publish("agent:"+text(job, "nodeId"), Object{"type": "command_ready"})
			}
			break
		}
	}
}
