CREATE TABLE `delegated_keys` (
	`user_id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`sealed_secret` blob NOT NULL,
	`created_at` integer NOT NULL,
	`activated_at` integer,
	`activated_at_block` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delegated_keys_public_key_unique` ON `delegated_keys` (`public_key`);