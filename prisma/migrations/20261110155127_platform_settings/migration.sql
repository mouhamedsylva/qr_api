-- AlterTable
ALTER TABLE `subscriptions` ADD COLUMN `requestedAt` DATETIME(3) NULL,
    ADD COLUMN `requestedCycle` ENUM('MONTHLY', 'YEARLY') NULL,
    ADD COLUMN `requestedPlanId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `platform_settings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `trialDays` INTEGER NOT NULL DEFAULT 14,
    `trialReminderDays` INTEGER NOT NULL DEFAULT 3,
    `updatedById` CHAR(36) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_requestedPlanId_fkey` FOREIGN KEY (`requestedPlanId`) REFERENCES `plans`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
