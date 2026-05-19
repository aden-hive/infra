package lifecycle

import (
	"context"
	"errors"
	"fmt"
)

type Hook func(context.Context) error

type Unit struct {
	Name  string
	After []string
	Start Hook
	Stop  Hook
}

type Manager struct {
	units []Unit
	names map[string]struct{}
}

func NewManager() *Manager {
	return &Manager{names: make(map[string]struct{})}
}

func (m *Manager) Register(units ...Unit) error {
	if m.names == nil {
		m.names = make(map[string]struct{})
	}

	for _, unit := range units {
		if unit.Name == "" {
			return errors.New("lifecycle unit name is required")
		}

		if _, ok := m.names[unit.Name]; ok {
			return fmt.Errorf("duplicate lifecycle unit %q", unit.Name)
		}

		m.names[unit.Name] = struct{}{}
		unit.After = append([]string(nil), unit.After...)
		m.units = append(m.units, unit)
	}

	return nil
}

func (m *Manager) Start(ctx context.Context) error {
	order, err := m.startOrder()
	if err != nil {
		return err
	}

	for _, unit := range order {
		if unit.Start == nil {
			continue
		}

		if err := unit.Start(ctx); err != nil {
			return fmt.Errorf("start %q: %w", unit.Name, err)
		}
	}

	return nil
}

func (m *Manager) Stop(ctx context.Context) error {
	order, err := m.startOrder()
	if err != nil {
		return err
	}

	var errs []error
	for i := len(order) - 1; i >= 0; i-- {
		unit := order[i]
		if unit.Stop == nil {
			continue
		}

		if err := unit.Stop(ctx); err != nil {
			errs = append(errs, fmt.Errorf("stop %q: %w", unit.Name, err))
		}
	}

	return errors.Join(errs...)
}

func (m *Manager) startOrder() ([]Unit, error) {
	units := make(map[string]Unit, len(m.units))
	for _, unit := range m.units {
		units[unit.Name] = unit
	}

	for _, unit := range m.units {
		for _, dependency := range unit.After {
			if _, ok := units[dependency]; !ok {
				return nil, fmt.Errorf("lifecycle unit %q depends on unknown unit %q", unit.Name, dependency)
			}
		}
	}

	permanent := make(map[string]struct{}, len(m.units))
	temporary := make(map[string]struct{}, len(m.units))
	order := make([]Unit, 0, len(m.units))

	var visit func(Unit) error
	visit = func(unit Unit) error {
		if _, ok := permanent[unit.Name]; ok {
			return nil
		}

		if _, ok := temporary[unit.Name]; ok {
			return fmt.Errorf("lifecycle dependency cycle includes unit %q", unit.Name)
		}

		temporary[unit.Name] = struct{}{}
		for _, dependency := range unit.After {
			if err := visit(units[dependency]); err != nil {
				return err
			}
		}

		delete(temporary, unit.Name)
		permanent[unit.Name] = struct{}{}
		order = append(order, unit)

		return nil
	}

	for _, unit := range m.units {
		if err := visit(unit); err != nil {
			return nil, err
		}
	}

	return order, nil
}
