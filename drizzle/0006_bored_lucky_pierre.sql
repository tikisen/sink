CREATE TABLE `click_history` (
	`link_id` text NOT NULL,
	`slug` text NOT NULL,
	`day` text NOT NULL,
	`dim` text NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`clicks` integer NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`link_id`, `day`, `dim`, `value`, `source`)
);
--> statement-breakpoint
CREATE INDEX `click_history_day_idx` ON `click_history` (`day`);--> statement-breakpoint
CREATE INDEX `click_history_source_day_idx` ON `click_history` (`source`,`day`);