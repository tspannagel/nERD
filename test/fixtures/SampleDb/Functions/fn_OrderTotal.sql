CREATE FUNCTION [dbo].[fn_OrderTotal] (@OrderId BIGINT)
RETURNS DECIMAL (18, 2)
AS
BEGIN
    /* sums all lines /* nested comment */ of an order */
    RETURN (SELECT SUM(Quantity * UnitPrice) FROM [Sales].[OrderLine] WHERE OrderId = @OrderId);
END
