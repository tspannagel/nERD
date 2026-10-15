CREATE FUNCTION [Sales].[fn_TopProducts] (@Top INT)
RETURNS @result TABLE (ProductId INT NOT NULL PRIMARY KEY, Sold INT NOT NULL)
AS
BEGIN
    INSERT INTO @result
    SELECT TOP (@Top) ol.ProductId, SUM(ol.Quantity)
    FROM Sales.OrderLine ol GROUP BY ol.ProductId ORDER BY 2 DESC;
    RETURN;
END
