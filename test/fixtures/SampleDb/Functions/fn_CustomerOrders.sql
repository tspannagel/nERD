CREATE FUNCTION dbo.fn_CustomerOrders (@CustomerId INT, @Since DATE = NULL)
RETURNS TABLE
AS
RETURN
    SELECT o.OrderId, o.OrderDate, o.Status
    FROM Sales.[Order] o
    WHERE o.CustomerId = @CustomerId AND (@Since IS NULL OR o.OrderDate >= @Since);
