-- CreateTable
CREATE TABLE `api_keys` (
    `id` CHAR(36) NOT NULL,
    `restaurantId` CHAR(36) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `prefix` VARCHAR(24) NOT NULL,
    `keyHash` CHAR(64) NOT NULL,
    `scopes` JSON NOT NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `api_keys_keyHash_key`(`keyHash`),
    INDEX `api_keys_restaurantId_idx`(`restaurantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_endpoints` (
    `id` CHAR(36) NOT NULL,
    `restaurantId` CHAR(36) NOT NULL,
    `url` VARCHAR(500) NOT NULL,
    `description` VARCHAR(255) NULL,
    `events` JSON NOT NULL,
    `secret` VARCHAR(80) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `failureCount` INTEGER NOT NULL DEFAULT 0,
    `disabledAt` DATETIME(3) NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `webhook_endpoints_restaurantId_idx`(`restaurantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_deliveries` (
    `id` CHAR(36) NOT NULL,
    `endpointId` CHAR(36) NOT NULL,
    `eventType` VARCHAR(64) NOT NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('PENDING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastStatusCode` INTEGER NULL,
    `lastError` VARCHAR(500) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `webhook_deliveries_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    INDEX `webhook_deliveries_endpointId_createdAt_idx`(`endpointId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `api_keys` ADD CONSTRAINT `api_keys_restaurantId_fkey` FOREIGN KEY (`restaurantId`) REFERENCES `restaurants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `webhook_endpoints` ADD CONSTRAINT `webhook_endpoints_restaurantId_fkey` FOREIGN KEY (`restaurantId`) REFERENCES `restaurants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `webhook_deliveries` ADD CONSTRAINT `webhook_deliveries_endpointId_fkey` FOREIGN KEY (`endpointId`) REFERENCES `webhook_endpoints`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
