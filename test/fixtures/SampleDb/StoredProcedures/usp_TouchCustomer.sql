CREATE PROC dbo.usp_TouchCustomer @CustomerId int
AS
UPDATE Customer SET IsActive = 1 WHERE CustomerId = @CustomerId;
GO
