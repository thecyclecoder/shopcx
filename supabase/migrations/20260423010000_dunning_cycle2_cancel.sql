-- Change dunning cycle 2 default from pause to cancel
-- Cancelled subs auto-reactivate when customer adds new payment method
UPDATE workspaces SET dunning_cycle_2_action = 'cancel' WHERE dunning_cycle_2_action = 'pause';
