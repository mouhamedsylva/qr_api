-- Le trigger d'origine (instruction unique) conservait son « ; » final dans
-- son corps, ce qui rendait les dumps mysqldump impossibles à restaurer.
-- Réécriture en bloc BEGIN … END, comme audit_logs_no_delete.
DROP TRIGGER IF EXISTS `audit_logs_no_update`;

CREATE TRIGGER `audit_logs_no_update` BEFORE UPDATE ON `audit_logs`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs est en ajout seul';
END;
