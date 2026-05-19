package lifecycle

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestStartRunsHooksInDependencyOrder(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	manager := NewManager()
	var calls []string

	err := manager.Register(
		Unit{Name: "api", After: []string{"database"}, Start: recordHook(&calls, "api")},
		Unit{Name: "cache"},
		Unit{Name: "database", Start: recordHook(&calls, "database")},
	)
	if err != nil {
		t.Fatalf("register units: %v", err)
	}

	if err := manager.Start(ctx); err != nil {
		t.Fatalf("start units: %v", err)
	}

	want := []string{"database", "api"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %v, want %v", calls, want)
	}
}

func TestStopRunsHooksInReverseDependencyOrder(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	manager := NewManager()
	var calls []string

	err := manager.Register(
		Unit{Name: "api", After: []string{"database"}, Stop: recordHook(&calls, "api")},
		Unit{Name: "database", Stop: recordHook(&calls, "database")},
		Unit{Name: "metrics"},
	)
	if err != nil {
		t.Fatalf("register units: %v", err)
	}

	if err := manager.Stop(ctx); err != nil {
		t.Fatalf("stop units: %v", err)
	}

	want := []string{"api", "database"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %v, want %v", calls, want)
	}
}

func TestRegisterRejectsDuplicateName(t *testing.T) {
	t.Parallel()

	manager := NewManager()
	err := manager.Register(Unit{Name: "api"}, Unit{Name: "api"})
	if err == nil {
		t.Fatal("expected duplicate name error")
	}

	if !strings.Contains(err.Error(), "duplicate") || !strings.Contains(err.Error(), "api") {
		t.Fatalf("error = %q, want duplicate api context", err.Error())
	}
}

func TestStartRejectsUnknownDependency(t *testing.T) {
	t.Parallel()

	manager := NewManager()
	err := manager.Register(Unit{Name: "api", After: []string{"database"}})
	if err != nil {
		t.Fatalf("register units: %v", err)
	}

	err = manager.Start(context.Background())
	if err == nil {
		t.Fatal("expected unknown dependency error")
	}

	if !strings.Contains(err.Error(), "api") || !strings.Contains(err.Error(), "database") {
		t.Fatalf("error = %q, want dependent and missing unit names", err.Error())
	}
}

func TestStartRejectsDependencyCycle(t *testing.T) {
	t.Parallel()

	manager := NewManager()
	err := manager.Register(
		Unit{Name: "api", After: []string{"worker"}},
		Unit{Name: "worker", After: []string{"api"}},
	)
	if err != nil {
		t.Fatalf("register units: %v", err)
	}

	err = manager.Start(context.Background())
	if err == nil {
		t.Fatal("expected cycle error")
	}

	if !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("error = %q, want cycle context", err.Error())
	}
}

func TestStopContinuesAfterErrors(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	manager := NewManager()
	firstErr := errors.New("first failed")
	secondErr := errors.New("second failed")
	var calls []string

	err := manager.Register(
		Unit{Name: "first", Stop: func(context.Context) error {
			calls = append(calls, "first")

			return firstErr
		}},
		Unit{Name: "second", After: []string{"first"}, Stop: func(context.Context) error {
			calls = append(calls, "second")

			return secondErr
		}},
		Unit{Name: "third", After: []string{"second"}, Stop: recordHook(&calls, "third")},
	)
	if err != nil {
		t.Fatalf("register units: %v", err)
	}

	err = manager.Stop(ctx)
	if err == nil {
		t.Fatal("expected joined stop error")
	}

	want := []string{"third", "second", "first"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %v, want %v", calls, want)
	}

	if !errors.Is(err, firstErr) || !errors.Is(err, secondErr) {
		t.Fatalf("error = %v, want joined first and second errors", err)
	}

	message := err.Error()
	if !strings.Contains(message, "stop \"first\"") || !strings.Contains(message, "stop \"second\"") {
		t.Fatalf("error = %q, want component context", message)
	}
}

func recordHook(calls *[]string, name string) Hook {
	return func(context.Context) error {
		*calls = append(*calls, name)

		return nil
	}
}
