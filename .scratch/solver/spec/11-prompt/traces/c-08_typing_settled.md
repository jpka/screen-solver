# Highest and Lowest

```javascript
function highAndLow(numbers){
  const parts = numbers.split(" ");
  let max = Number(parts[0]);
  let min = max;

  for (let i = 1; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (n > max) max = n;
    if (n < min) min = n;
  }

  return `${max} ${min}`;
}
```

One pass over the split tokens, tracking the running maximum and minimum. Seeding both from the first element rather than from `Infinity` sentinels is safe here because the notes guarantee at least one number in the string.

The return is a string, not an array — the sample test asserts `highAndLow("8 3 -5 42 -1 0 0 -9 4 7 4 -4") === "42 -9"`, so the shape is a single space-separated string with the highest first. A sort would also work but does more than the problem needs, and sorting the raw tokens without converting them to numbers would compare them as strings.

O(n) time, O(n) space for the split (O(1) beyond it).
