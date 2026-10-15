CREATE PROCEDURE [Sales].[usp_PlaceOrder]
    @CustomerId INT,
    @ProductId  INT,
    @Quantity   INT = 1,
    @OrderId    BIGINT OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    CREATE TABLE #tmp (Id INT);
    DECLARE @price DECIMAL(18,2) = (SELECT Price FROM Sales.Product WHERE ProductId = @ProductId);
    INSERT INTO [Sales].[Order] (CustomerId, OrderDate, Status) VALUES (@CustomerId, CAST(GETDATE() AS DATE), 0);
    SET @OrderId = SCOPE_IDENTITY();
    INSERT INTO Sales.OrderLine (OrderId, [LineNo], ProductId, Quantity, UnitPrice)
    VALUES (@OrderId, 1, @ProductId, @Quantity, @price);
    EXEC dbo.usp_TouchCustomer @CustomerId;
END
