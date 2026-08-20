if vim.fn.has("nvim-0.10") == 1 then
	vim.g.clipboard = "osc52"
end

local function copy()
	return { vim.fn.getreg('"') }
end

local function paste()
	return vim.fn.split(vim.fn.getreg('"'), "\n")
end

vim.g.clipboard = {
	name = "OSC 52",
	copy = {
		["+"] = copy,
		["*"] = copy,
	},
	paste = {
		["+"] = paste,
		["*"] = paste,
	},
}
