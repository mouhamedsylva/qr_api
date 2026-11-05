-- AlterTable
ALTER TABLE `subscriptions` ADD COLUMN `lastNotice` VARCHAR(30) NULL;

-- CreateTable
CREATE TABLE `notification_outbox` (
    `id` CHAR(36) NOT NULL,
    `channel` ENUM('EMAIL', 'SMS', 'WHATSAPP') NOT NULL,
    `to` VARCHAR(191) NOT NULL,
    `subject` VARCHAR(200) NULL,
    `body` TEXT NOT NULL,
    `template` VARCHAR(50) NULL,
    `status` ENUM('PENDING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL,
    `lastError` VARCHAR(500) NULL,
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notification_outbox_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_locks` (
    `name` VARCHAR(64) NOT NULL,
    `lockedUntil` DATETIME(3) NOT NULL,
    `owner` VARCHAR(64) NOT NULL,
    `lastRunAt` DATETIME(3) NULL,
    `lastError` VARCHAR(500) NULL,

    PRIMARY KEY (`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
