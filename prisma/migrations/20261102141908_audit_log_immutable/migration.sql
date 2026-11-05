-- Journal d'audit inaltérable (CON-04) : la base refuse toute modification.
-- La suppression n'est possible qu'en positionnant explicitement
-- @allow_audit_purge = 1 dans la session (purge de rétention, base de test).
CREATE TRIGGER `audit_logs_no_update` BEFORE UPDATE ON `audit_logs`
FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs est en ajout seul';

CREATE TRIGGER `audit_logs_no_delete` BEFORE DELETE ON `audit_logs`
FOR EACH ROW
BEGIN
  IF @allow_audit_purge IS NULL OR @allow_audit_purge <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs est en ajout seul';
  END IF;
END;
